"""Gateway regressions use an isolated app, temporary databases, and mocked LAN I/O."""
import importlib.util
import ipaddress
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
TOKEN = 'gateway-form-test-token'
AGENT_TOKEN = 'gateway-agent-test-token'
INTERFACES = [
    {'ipv4': '10.88.0.2', 'subnet_mask': '255.255.255.248', 'default_gateway': '10.88.0.1'},
    {'ipv4': '10.88.0.4', 'subnet_mask': '255.255.255.248'},
    {'ipv4': '192.168.50.2', 'subnet_mask': '255.255.255.0'},
]


def setUpModule():
    global m, resources
    resources = ExitStack()
    try:
        temporary = resources.enter_context(tempfile.TemporaryDirectory(prefix='gateway_contract_'))
        resources.enter_context(patch.dict(os.environ, {
            'PYPONDO_DATA_DIR': temporary,
            'PYPONDO_DB_PATH': str(Path(temporary) / 'pccafe.db'),
            'PYPONDO_COMMUNITY_DB_PATH': str(Path(temporary) / 'community_equipment.db'),
            'PYPONDO_AUTH_DB_PATH': str(Path(temporary) / 'auth.db'),
            'PYPONDO_SECRET_KEY': 'disposable-gateway-test-secret',
            'LAN_AGENT_TOKEN': AGENT_TOKEN,
            'LAN_AGENT_DEFAULT_PORT': '5001',
            'LAN_SCAN_TTL_SECONDS': '45',
            'LAN_SCAN_MAX_HOSTS': '254',
            'LAN_SCAN_WORKERS': '2',
            'LAN_SCAN_DNS_WORKERS': '2',
            'LAN_SCAN_ENABLE_NETBIOS': '0',
        }))
        resources.enter_context(patch.object(sys, 'dont_write_bytecode', True))
        resources.enter_context(patch.object(sys, 'path', [str(HERE), *sys.path]))
        name = '_gateway_contract_app'
        spec = importlib.util.spec_from_file_location(name, HERE / 'app.py')
        m = importlib.util.module_from_spec(spec)
        sys.modules[name] = m
        resources.callback(sys.modules.pop, name, None)
        spec.loader.exec_module(m)
        m.app.config.update(TESTING=True)
        for path in (m.database_path, m.community_db_path, m.auth_db_path):
            assert Path(path).parent == Path(temporary), 'Refusing to use a non-test database'
        with m.app.app_context():
            m.initialize_database()
            for role in ('administrator', 'dean', 'student', 'it_technician'):
                m.db.session.add(m.User(username='network-' + role, role=role,
                    is_admin=role == 'administrator', is_active_staff=True,
                    password_hash='unused-session-authentication'))
            m.db.session.commit()
        resources.callback(dispose_databases)
    except BaseException:
        resources.close()
        raise


def dispose_databases():
    with m.app.app_context():
        m.db.session.remove()
        for engine in m.db.engines.values():
            engine.dispose()


def tearDownModule():
    resources.close()


class GatewayNetworksTests(unittest.TestCase):
    def setUp(self):
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        self.io = {}
        for name, result in {
            'parse_ipv4_interfaces': INTERFACES,
            'discover_lan_ipv4_neighbors': [],
            'discover_lan_ipv6_neighbors': [],
            'ping_ipv4_host': False,
            'reverse_dns_name': None,
            'netbios_name': None,
            'send_lan_command': (True, 'Mock command queued'),
            'run_cached_network_command': '',
            'get_default_gateway_ips': [],
        }.items():
            self.io[name] = self.patches.enter_context(patch.object(m, name, return_value=result))
        # Tripwires: a new unmocked path must not run OS commands or contact hosts.
        self.patches.enter_context(patch.object(m.subprocess, 'Popen',
            side_effect=AssertionError('No subprocesses in gateway tests')))
        self.patches.enter_context(patch.object(m.socket, 'gethostbyaddr',
            side_effect=AssertionError('No DNS in gateway tests')))
        self.patches.enter_context(patch.object(m.socket, 'create_connection',
            side_effect=AssertionError('No sockets in gateway tests')))
        self.patches.enter_context(patch.object(m.requests.sessions.Session, 'request',
            side_effect=AssertionError('No HTTP in gateway tests')))
        self.patches.enter_context(patch.object(m, 'LAN_SCAN_CACHE', {}))
        self.patches.enter_context(patch.object(m, 'LAN_SCAN_SLOTS', threading.BoundedSemaphore(2)))
        with m.app.app_context():
            for model in (m.Session, m.LanCommand, m.AdminLog, m.PC, m.RoomNetwork):
                model.query.delete()
            m.db.session.commit()
        self.client = m.app.test_client()

    def login(self, role='administrator', client=None):
        client = client or self.client
        with m.app.app_context():
            user_id = m.User.query.filter_by(username='network-' + role).one().id
        with client.session_transaction() as session:
            session.clear()
            session['_user_id'] = str(user_id)
            session['_fresh'] = True
            session['_network_csrf_token'] = TOKEN
        return client

    def network(self, room='A Lab', cidr='10.88.0.0/29', gateway='10.88.0.1'):
        with m.app.app_context():
            row = m.RoomNetwork(room=room, cidr=cidr, gateway_ip=gateway)
            m.db.session.add(row)
            m.db.session.commit()
            return row.id

    def pc(self, name='Approved-PC', ip='10.88.0.3', **kwargs):
        with m.app.app_context():
            row = m.PC(name=name, lan_ip=ip, **kwargs)
            m.db.session.add(row)
            m.db.session.commit()
            return row.id

    def rows(self, model):
        with m.app.app_context():
            return [{column.name: getattr(row, column.name) for column in model.__table__.columns}
                for row in model.query.order_by(model.id).all()]

    def snapshot(self):
        return [self.rows(model) for model in (m.PC, m.RoomNetwork, m.AdminLog, m.LanCommand)]

    def summary(self, network_id):
        with m.app.app_context():
            return m.build_saved_ipv4_network_summary(m.db.session.get(m.RoomNetwork, network_id))

    def scan_result(self, ips=('10.88.0.3', '10.88.0.5'), **kwargs):
        return dict(ok=True, clients=[{'ip': ip, 'source_pc_name': 'Discovered-PC',
            'room': 'A Lab'} for ip in ips], client_count=len(ips), stale=False, **kwargs)

    def cache_scan(self, network_id, result=None, age=0):
        summary = self.summary(network_id)
        m._store_gateway_scan_cache(summary, result if result is not None else self.scan_result())
        entry = m.LAN_SCAN_CACHE[m.gateway_scan_key(summary)]
        entry['timestamp'] -= age
        return entry

    def save(self, network_id, ips, **extra):
        return self.client.post('/admin/pcs/save-discovered', data={
            'network_id': network_id, 'selected_ips': ips, 'csrf_token': TOKEN, **extra})

    def assert_redirect_network(self, response, network_id):
        self.assertEqual(response.status_code, 302, response.get_data(as_text=True))
        location = urlsplit(response.location)
        self.assertEqual(location.path, '/dean/pcs')
        self.assertEqual(parse_qs(location.query)['network_id'], [str(network_id)])

    def assert_no_mutation(self, before):
        self.assertEqual(self.snapshot(), before)
        self.io['send_lan_command'].assert_not_called()

    def register(self, payload, token=AGENT_TOKEN):
        return self.client.post('/api/agent/register-lan', json=payload,
            headers={'X-Agent-Token': token}, environ_base={'REMOTE_ADDR': '10.88.0.3'})

    def test_validation_accepts_only_private_subnets_and_canonicalizes(self):
        for cidr, gateway, canonical in (
            ('10.88.0.6/29', '10.88.0.1', '10.88.0.0/29'),
            ('172.16.1.0/24', '172.16.1.254', '172.16.1.0/24'),
            ('192.168.50.0/30', '192.168.50.2', '192.168.50.0/30'),
        ):
            with self.subTest(cidr=cidr):
                network, actual_gateway = m.validate_gateway_network(cidr, gateway)
                self.assertEqual(str(network), canonical)
                self.assertEqual(actual_gateway, gateway)

    def test_validation_rejects_invalid_nonprivate_and_unusable_gateways(self):
        for cidr, gateway in (
            ('', ''), ('bad', '10.88.0.1'), ('10.88.0.0/33', '10.88.0.1'),
            ('2001:db8::/64', '2001:db8::1'), ('10.88.0.0/29', '::1'),
            ('8.8.8.0/24', '8.8.8.1'), ('127.0.0.0/8', '127.0.0.1'),
            ('169.254.0.0/16', '169.254.0.1'), ('100.64.0.0/10', '100.64.0.1'),
            ('198.18.0.0/15', '198.18.0.1'), ('172.0.0.0/8', '172.16.0.1'),
            ('10.88.0.0/29', '10.88.0.0'), ('10.88.0.0/29', '10.88.0.7'),
            ('10.88.0.0/29', '10.89.0.1'), ('10.88.0.0/31', '10.88.0.1'),
            ('10.88.0.1/32', '10.88.0.1'),
        ):
            with self.subTest(cidr=cidr, gateway=gateway), self.assertRaises(ValueError):
                m.validate_gateway_network(cidr, gateway)

    def test_add_gateway_canonicalizes_audits_and_does_not_assign_pcs(self):
        self.login()
        self.pc(ip=None)
        pcs_before = self.rows(m.PC)
        response = self.client.post('/rooms/network', data={'csrf_token': TOKEN,
            'room': ' A Lab ', 'cidr': '10.88.0.6/29', 'gateway_ip': '10.88.0.1',
            'router_name': ' Test Router '})
        row, = self.rows(m.RoomNetwork)
        self.assertEqual((row['room'], row['cidr'], row['gateway_ip'], row['router_name']),
            ('A Lab', '10.88.0.0/29', '10.88.0.1', 'Test Router'))
        self.assert_redirect_network(response, row['id'])
        self.assertEqual(self.rows(m.PC), pcs_before)
        self.assertTrue(any('10.88.0.1' in row['action'] for row in self.rows(m.AdminLog)))
        self.io['discover_lan_ipv4_neighbors'].assert_not_called()
        self.io['send_lan_command'].assert_not_called()

    def test_invalid_duplicate_and_overlapping_gateway_forms_flash_without_mutation(self):
        self.login()
        self.network()
        before = self.snapshot()
        for invalid in (
            {'room': ''}, {'room': 'x' * 81}, {'router_name': 'x' * 121},
            {'cidr': '8.8.8.0/24', 'gateway_ip': '8.8.8.1'},
            {'gateway_ip': '10.89.0.7'}, {'cidr': '::/64'}, {'cidr': 'bad'},
            {'room': 'A Lab'},
            {'cidr': '10.88.0.6/29', 'gateway_ip': '10.88.0.1'},
            {'cidr': '10.88.0.0/30', 'gateway_ip': '10.88.0.1'},
            {'cidr': '10.88.0.0/24', 'gateway_ip': '10.88.0.1'},
        ):
            with self.subTest(invalid=invalid):
                response = self.client.post('/rooms/network', data={'csrf_token': TOKEN,
                    'room': 'Other Lab', 'cidr': '10.89.0.0/29', 'gateway_ip': '10.89.0.1', **invalid})
                self.assertEqual(response.status_code, 302)
                with self.client.session_transaction() as session:
                    self.assertTrue(any(category == 'error' for category, _ in session.pop('_flashes', [])))
                self.assert_no_mutation(before)

    def test_admin_only_mutations_and_discovery_api_permissions(self):
        network_id = self.network()
        pc_id = self.pc()
        self.cache_scan(network_id)
        for role in ('dean', 'student', 'it_technician'):
            with self.subTest(role=role):
                self.login(role)
                before = self.snapshot()
                self.assertEqual(self.client.post('/rooms/network', data={'csrf_token': TOKEN}).status_code, 403)
                self.assertEqual(self.save(network_id, ['10.88.0.5']).status_code, 403)
                self.assertEqual(self.client.get('/api/admin/lan-discovery').status_code, 403)
                if role != 'dean':
                    response = self.client.post('/dean/pc-command', data={'csrf_token': TOKEN,
                        'network_id': network_id, 'pc_id': pc_id, 'command': 'lock'})
                    self.assertEqual(response.status_code, 403)
                self.assert_no_mutation(before)
        self.io['discover_lan_ipv4_neighbors'].assert_not_called()

    def test_anonymous_requests_never_scan_or_mutate(self):
        before = self.snapshot()
        with patch.object(m, 'get_gateway_client_scan') as scan:
            self.assertEqual(self.client.get('/dean/pcs').status_code, 302)
            for path in ('/rooms/network', '/admin/pcs/save-discovered', '/dean/pc-command'):
                self.assertEqual(self.client.post(path).status_code, 302)
            scan.assert_not_called()
        self.assert_no_mutation(before)

    def test_all_network_forms_require_matching_session_csrf(self):
        network_id, pc_id = self.network(), self.pc()
        self.cache_scan(network_id)
        for role, path in (('administrator', '/rooms/network'),
                ('administrator', '/admin/pcs/save-discovered'),
                ('administrator', '/dean/pc-command'), ('dean', '/dean/pc-command')):
            for token in (None, 'forged', 'non-ascii-\u00e9'):
                with self.subTest(role=role, path=path, token=token):
                    self.login(role)
                    before = self.snapshot()
                    data = {'network_id': network_id, 'pc_id': pc_id, 'command': 'lock',
                        'selected_ips': ['10.88.0.5'], 'room': 'New Lab',
                        'cidr': '10.89.0.0/29', 'gateway_ip': '10.89.0.1'}
                    if token is not None:
                        data['csrf_token'] = token
                    self.assertEqual(self.client.post(path, data=data).status_code, 400)
                    self.assert_no_mutation(before)
            self.login(role)
            with self.client.session_transaction() as session:
                session.pop('_network_csrf_token')
            self.assertEqual(self.client.post(path, data={'csrf_token': TOKEN}).status_code, 400)

    def test_csrf_helper_is_global_stable_and_session_specific(self):
        self.assertIs(m.app.jinja_env.globals['network_csrf_token'], m.network_csrf_token)
        tokens = []
        for client in (self.client, m.app.test_client()):
            self.login(client=client)
            with client.session_transaction() as session:
                session.pop('_network_csrf_token')
            response = client.get('/dean/pcs')
            with client.session_transaction() as session:
                token = session['_network_csrf_token']
            self.assertTrue(token)
            self.assertIn(f'name="csrf_token" value="{token}"'.encode(), response.data)
            client.get('/dean/pcs')
            with client.session_transaction() as session:
                self.assertEqual(session['_network_csrf_token'], token)
            tokens.append(token)
        self.assertNotEqual(*tokens)

    def test_no_saved_networks_do_not_scan_even_on_refresh(self):
        for role in ('administrator', 'dean'):
            with self.subTest(role=role):
                self.login(role)
                with patch.object(m, 'get_gateway_client_scan') as scan, \
                        patch.object(m, 'build_primary_ipv4_network_summary') as primary:
                    page = self.client.get('/dean/pcs?refresh=1')
                    self.assertEqual(page.status_code, 200)
                    self.assertIn(b'No gateways have been saved', page.data)
                    self.assertIn(b'0 PCs', page.data)
                    scan.assert_not_called()
                    primary.assert_not_called()
        self.io['parse_ipv4_interfaces'].assert_not_called()

    def test_selector_defaults_to_first_room_and_passes_explicit_summary_and_force(self):
        z_id = self.network('Z Lab', '10.89.0.0/29', '10.89.0.1')
        a_id = self.network()
        self.pc('Visible-PC')
        self.pc('Other-Network-PC', '10.89.0.3')
        self.pc('Server-PC', '10.88.0.4')
        self.pc('Router-PC', '10.88.0.1')
        for role in ('administrator', 'dean'):
            self.login(role)
            with patch.object(m, 'get_gateway_client_scan', return_value=self.scan_result(())) as scan:
                page = self.client.get('/dean/pcs')
                scan.assert_called_with(non_blocking=True, summary=self.summary(a_id), force=False)
                self.assertIn(f'<option value="{a_id}" selected'.encode(), page.data)
                self.assertIn(b'Visible-PC', page.data)
                for hidden in (b'Other-Network-PC', b'Server-PC', b'Router-PC'):
                    self.assertNotIn(hidden, page.data)
                self.assertIn(b'1 PCs', page.data)
                self.assertIn(b'name="refresh" value="1"', page.data)
                self.assertIn(f'name="network_id" value="{a_id}"'.encode(), page.data)
                page = self.client.get(f'/dean/pcs?network_id={z_id}&refresh=1')
                scan.assert_called_with(non_blocking=True, summary=self.summary(z_id), force=True)
                self.assertIn(b'Other-Network-PC', page.data)
                self.assertNotIn(b'Visible-PC', page.data)
                self.client.get(f'/dean/pcs?network_id={z_id}&refresh=0')
                self.assertIs(scan.call_args.kwargs['force'], False)
        self.io['send_lan_command'].assert_not_called()

    def test_student_and_technician_pages_do_not_scan(self):
        self.network()
        for role in ('student', 'it_technician'):
            self.login(role)
            with patch.object(m, 'get_gateway_client_scan') as scan:
                self.assertEqual(self.client.get('/dean/pcs').status_code, 302)
                scan.assert_not_called()

    def test_invalid_network_selectors_are_rejected_without_scan(self):
        self.login()
        for value, status in (('', 400), ('bad', 400), ('999999', 404)):
            with self.subTest(value=value), patch.object(m, 'get_gateway_client_scan') as scan:
                self.assertEqual(self.client.get('/dean/pcs', query_string={'network_id': value}).status_code, status)
                scan.assert_not_called()

    def test_invalid_and_overlapping_saved_mappings_show_error_without_scan(self):
        self.login()
        network_id = self.network(cidr='broken')
        with patch.object(m, 'get_gateway_client_scan') as scan:
            page = self.client.get('/dean/pcs')
            self.assertEqual(page.status_code, 200)
            self.assertIn(b'Gateway discovery unavailable', page.data)
            scan.assert_not_called()
            with m.app.app_context():
                m.db.session.get(m.RoomNetwork, network_id).cidr = '10.88.0.0/29'
                m.db.session.commit()
            self.network('Overlap', '10.88.0.0/24')
            page = self.client.get(f'/dean/pcs?network_id={network_id}')
            self.assertIn(b'overlap', page.data)
            scan.assert_not_called()

    def test_discovery_empty_failure_escaping_and_admin_selection_ui(self):
        network_id = self.network(room='<script>room</script>')
        result = self.scan_result(('10.88.0.3',))
        result['clients'][0].update(source_pc_name='<script>device</script>', room='<script>room</script>')
        for role in ('administrator', 'dean'):
            self.login(role)
            before = self.snapshot()
            with patch.object(m, 'get_gateway_client_scan', return_value=result) as scan:
                page = self.client.get(f'/dean/pcs?network_id={network_id}')
                for text in ('room', 'device'):
                    self.assertIn(f'&lt;script&gt;{text}&lt;/script&gt;'.encode(), page.data)
                    self.assertNotIn(f'<script>{text}</script>'.encode(), page.data)
                self.assertEqual(b'name="selected_ips"' in page.data, role == 'administrator')
                self.assertEqual(b'Save selected PCs' in page.data, role == 'administrator')
                self.assertEqual(b'Add a gateway' in page.data, role == 'administrator')
                scan.return_value = dict(self.scan_result(()), stale=True)
                page = self.client.get('/dean/pcs')
                self.assertIn(b'No client devices have been detected', page.data)
                self.assertIn(b'Discovery is running in the background', page.data)
                scan.return_value = {'ok': False, 'clients': [], 'error': '<script>failure</script>'}
                page = self.client.get('/dean/pcs')
                self.assertEqual(page.status_code, 200)
                self.assertIn(b'Gateway discovery unavailable', page.data)
                self.assertIn(b'&lt;script&gt;failure&lt;/script&gt;', page.data)
            self.assert_no_mutation(before)

    def test_saved_summary_includes_all_interfaces_and_handles_no_local_subnet(self):
        network_id = self.network()
        self.assertEqual(self.summary(network_id), {'network_id': network_id, 'room': 'A Lab',
            'cidr': '10.88.0.0/29', 'gateway_ipv4': '10.88.0.1', 'local_ipv4': '10.88.0.2',
            'local_ipv4_addresses': ['10.88.0.2', '10.88.0.4', '192.168.50.2'],
            'subnet_mask': '255.255.255.248'})
        self.io['parse_ipv4_interfaces'].return_value = [{'ipv4': '192.168.50.2'}, {'ipv4': 'bad'}]
        summary = self.summary(network_id)
        self.assertIsNone(summary['local_ipv4'])
        self.assertEqual(summary['local_ipv4_addresses'], ['192.168.50.2'])

    def test_quick_and_full_scans_filter_arp_and_all_local_interfaces(self):
        summary = self.summary(self.network())
        self.pc()
        self.io['discover_lan_ipv4_neighbors'].return_value = [
            '10.88.0.5', '10.88.0.3', '10.88.0.0', '10.88.0.7', '10.88.0.1',
            '10.88.0.2', '10.88.0.4', '10.89.0.3', '192.168.50.2', 'bad', '::1']
        self.io['reverse_dns_name'].return_value = 'workstation.campus.local'
        before = self.snapshot()
        for function in (m._quick_gateway_scan_result, m._full_gateway_scan):
            with self.subTest(function=function.__name__), m.app.app_context():
                result = function(summary)
                self.assertTrue(result['ok'])
                self.assertEqual([host['ip'] for host in result['clients']], ['10.88.0.3', '10.88.0.5'])
                self.assertEqual(result['clients'][0]['mapped_pc_name'], 'Approved-PC')
                self.assertEqual(result['client_count'], 2)
        self.assertEqual({call.args[0] for call in self.io['ping_ipv4_host'].call_args_list},
            {'10.88.0.3', '10.88.0.5', '10.88.0.6'})
        self.assertEqual({call.args[0] for call in self.io['reverse_dns_name'].call_args_list},
            {'10.88.0.3', '10.88.0.5'})
        self.assert_no_mutation(before)

    def test_full_scan_merges_ping_with_arp_and_tolerates_dns_failure(self):
        summary = self.summary(self.network())
        self.io['discover_lan_ipv4_neighbors'].return_value = ['10.88.0.3']
        self.io['ping_ipv4_host'].side_effect = lambda ip, timeout: ip == '10.88.0.5'
        self.io['reverse_dns_name'].side_effect = RuntimeError('mock DNS unavailable')
        with m.app.app_context():
            result = m._full_gateway_scan(summary)
        self.assertEqual([host['ip'] for host in result['clients']], ['10.88.0.3', '10.88.0.5'])
        self.assertTrue(all(host['source_pc_name'] == 'unknown' for host in result['clients']))

    def test_oversized_network_rejected_before_host_enumeration_or_io(self):
        summary = self.summary(self.network(cidr='10.0.0.0/8', gateway='10.0.0.1'))
        with patch.object(ipaddress.IPv4Network, 'hosts', side_effect=AssertionError('Must not enumerate')) as hosts:
            result = m._full_gateway_scan(summary)
        self.assertFalse(result['ok'])
        self.assertIn('too large', result['error'])
        hosts.assert_not_called()
        for name in ('discover_lan_ipv4_neighbors', 'ping_ipv4_host', 'reverse_dns_name'):
            self.io[name].assert_not_called()

    def test_cache_key_isolates_network_gateway_and_local_interface_changes(self):
        summary = self.summary(self.network())
        key = m.gateway_scan_key(summary)
        self.assertIsInstance(key, tuple)
        self.assertEqual(key, m.gateway_scan_key(dict(summary,
            local_ipv4_addresses=list(reversed(summary['local_ipv4_addresses'])))))
        for change in ({'network_id': 999}, {'cidr': '10.89.0.0/29'},
                {'gateway_ipv4': '10.88.0.6'}, {'local_ipv4': '10.88.0.4'},
                {'local_ipv4_addresses': ['10.88.0.2']}):
            with self.subTest(change=change):
                self.assertNotEqual(key, m.gateway_scan_key(dict(summary, **change)))

    def test_fresh_cache_isolated_and_force_refreshes_only_selected_network(self):
        first = self.summary(self.network())
        second = self.summary(self.network('B Lab', '10.89.0.0/29', '10.89.0.1'))
        first_result, second_result = self.scan_result(), self.scan_result(('10.89.0.3',))
        m._store_gateway_scan_cache(first, first_result)
        m._store_gateway_scan_cache(second, second_result)
        with patch.object(m, '_full_gateway_scan', return_value=self.scan_result(())) as full, \
                patch.object(m, '_trigger_gateway_scan_background') as trigger:
            self.assertEqual(m.get_gateway_client_scan(summary=first, non_blocking=True), first_result)
            self.assertEqual(m.get_gateway_client_scan(summary=second), second_result)
            full.assert_not_called()
            trigger.assert_not_called()
            stale = m.get_gateway_client_scan(summary=first, force=True, non_blocking=True)
            self.assertTrue(stale['stale'])
            self.assertFalse(first_result['stale'])
            trigger.assert_called_once_with(first)
            m.get_gateway_client_scan(summary=first, force=True)
            full.assert_called_once_with(first)
            self.assertEqual(m.LAN_SCAN_CACHE[m.gateway_scan_key(second)]['result'], second_result)

    def test_expired_or_missing_cache_returns_quick_result_and_schedules_explicit_summary(self):
        network_id = self.network()
        summary = self.summary(network_id)
        with m.app.app_context(), patch.object(m, '_trigger_gateway_scan_background') as trigger:
            result = m.get_gateway_client_scan(summary=summary, non_blocking=True)
            self.assertTrue(result['stale'])
            self.assertEqual(result['mode'], 'quick')
            self.assertEqual(m.LAN_SCAN_CACHE[m.gateway_scan_key(summary)]['result']['clients'], [])
            trigger.assert_called_once_with(summary)
            trigger.reset_mock()
            entry = self.cache_scan(network_id, age=46)
            result = m.get_gateway_client_scan(summary=summary, non_blocking=True)
            self.assertTrue(result['stale'])
            self.assertEqual(result['clients'], entry['result']['clients'])
            trigger.assert_called_once_with(summary)

    def test_background_scan_has_app_context_and_clears_running_state(self):
        summary = self.summary(self.network())
        self.io['discover_lan_ipv4_neighbors'].return_value = ['10.88.0.3']
        self.io['reverse_dns_name'].return_value = 'gateway-test.local'
        key = m.gateway_scan_key(summary)
        m.LAN_SCAN_CACHE[key] = {'scan_in_progress': True}
        m._run_gateway_scan_background(summary)
        entry = m.LAN_SCAN_CACHE[key]
        self.assertTrue(entry['result']['ok'])
        self.assertEqual(entry['result']['clients'][0]['source_pc_name'], 'gateway-test')
        self.assertFalse(entry['scan_in_progress'])
        self.assertGreater(entry['timestamp'], 0)

    def test_background_failure_clears_only_its_own_cache_and_can_retry(self):
        first = self.summary(self.network())
        second = self.summary(self.network('B Lab', '10.89.0.0/29', '10.89.0.1'))
        m._store_gateway_scan_cache(second, self.scan_result(('10.89.0.3',)))
        other_before = dict(m.LAN_SCAN_CACHE[m.gateway_scan_key(second)])
        m.LAN_SCAN_CACHE[m.gateway_scan_key(first)] = {'scan_in_progress': True}
        with patch.object(m, '_full_gateway_scan', side_effect=RuntimeError('mock scan failure')), \
                self.assertLogs(m.app.logger, level='ERROR'):
            m._run_gateway_scan_background(first)
        entry = m.LAN_SCAN_CACHE[m.gateway_scan_key(first)]
        self.assertFalse(entry['scan_in_progress'])
        self.assertFalse(entry['result']['ok'])
        self.assertEqual(entry['result']['clients'], [])
        self.assertEqual(m.LAN_SCAN_CACHE[m.gateway_scan_key(second)], other_before)
        with patch.object(m, '_trigger_gateway_scan_background') as trigger:
            m.get_gateway_client_scan(summary=first, non_blocking=True, force=True)
            trigger.assert_called_once_with(first)

    def test_background_trigger_deduplicates_and_bounds_two_scans_then_releases_slots(self):
        summary = self.summary(self.network())
        summaries = [dict(summary, network_id=index) for index in (101, 102, 103)]
        with patch.object(m.threading, 'Thread') as thread, \
                patch.object(m, '_full_gateway_scan', return_value=self.scan_result(())):
            m._trigger_gateway_scan_background(summaries[0])
            m._trigger_gateway_scan_background(summaries[0])
            m._trigger_gateway_scan_background(summaries[1])
            m._trigger_gateway_scan_background(summaries[2])
            self.assertEqual(thread.call_count, 2)
            self.assertEqual(thread.return_value.start.call_count, 2)
            self.assertFalse(m.LAN_SCAN_CACHE[m.gateway_scan_key(summaries[2])].get('scan_in_progress', False))
            targets = [call.kwargs['target'] for call in thread.call_args_list]
            targets[0]()
            m._trigger_gateway_scan_background(summaries[2])
            self.assertEqual(thread.call_count, 3)
            targets[1]()
            thread.call_args.kwargs['target']()
            self.assertTrue(all(not entry['scan_in_progress'] for entry in m.LAN_SCAN_CACHE.values()))

    def test_save_only_selected_ips_is_idempotent_collision_safe_and_not_a_heartbeat(self):
        self.login()
        network_id = self.network()
        self.pc('Discovered-PC', None, room='Unassigned')
        original = self.rows(m.PC)[0]
        scan = self.scan_result(('10.88.0.3', '10.88.0.5', '10.88.0.6'))
        for host in scan['clients']:
            host['source_pc_name'] = 'Discovered-PC-with-a-very-long-hostname'
        self.cache_scan(network_id, scan)
        response = self.save(network_id, ['10.88.0.3', '10.88.0.5', '10.88.0.3'],
            name='forged-name', room='forged-room', lan_ip='10.88.0.6')
        self.assert_redirect_network(response, network_id)
        rows = self.rows(m.PC)
        self.assertEqual(rows[0], original, 'Existing unassigned PCs must not be autoassigned')
        new = rows[1:]
        self.assertEqual({row['lan_ip'] for row in new}, {'10.88.0.3', '10.88.0.5'})
        self.assertEqual(len({row['name'] for row in rows}), len(rows))
        self.assertTrue(all(0 < len(row['name']) <= 20 for row in new))
        self.assertTrue(all(row['room'] == 'A Lab' for row in new))
        self.assertTrue(all(row['lan_port'] == 5001 for row in new))
        self.assertTrue(all(row['last_agent_seen_at'] is None and row['online_since_at'] is None for row in new))
        self.assertEqual(len(self.rows(m.AdminLog)), 2)
        for ip in ('10.88.0.3', '10.88.0.5'):
            self.assertTrue(any(ip in row['action'] for row in self.rows(m.AdminLog)))
        before = self.snapshot()
        self.assert_redirect_network(self.save(network_id, ['10.88.0.3', '10.88.0.5']), network_id)
        self.assert_no_mutation(before)
        self.io['discover_lan_ipv4_neighbors'].assert_not_called()

    def test_save_skips_existing_ip_without_renaming_or_touching_heartbeat(self):
        self.login()
        network_id = self.network()
        seen = datetime.now() - timedelta(days=1)
        self.pc(last_agent_seen_at=seen, online_since_at=seen, room='Original room')
        original = self.rows(m.PC)[0]
        self.cache_scan(network_id)
        self.assert_redirect_network(self.save(network_id, ['10.88.0.3', '10.88.0.5']), network_id)
        self.assertEqual(self.rows(m.PC)[0], original)
        self.assertEqual(len(self.rows(m.PC)), 2)
        self.assertEqual(len(self.rows(m.AdminLog)), 1)

    def test_empty_selection_redirects_without_snapshot_or_mutation(self):
        self.login()
        network_id = self.network()
        before = self.snapshot()
        self.assert_redirect_network(self.save(network_id, []), network_id)
        self.assert_no_mutation(before)

    def test_save_rejects_expired_missing_failed_and_other_network_snapshots(self):
        self.login()
        network_id = self.network()
        other_id = self.network('B Lab', '10.89.0.0/29', '10.89.0.1')
        self.cache_scan(other_id, self.scan_result(('10.89.0.3',)))
        for state in ('missing', 'expired', 'ttl-boundary', 'failed'):
            with self.subTest(state=state):
                m.LAN_SCAN_CACHE.pop(m.gateway_scan_key(self.summary(network_id)), None)
                if state == 'expired':
                    self.cache_scan(network_id, age=46)
                elif state == 'ttl-boundary':
                    self.cache_scan(network_id, age=45)
                elif state == 'failed':
                    self.cache_scan(network_id, {'ok': False, 'clients': []})
                before = self.snapshot()
                self.assertEqual(self.save(network_id, ['10.88.0.3']).status_code, 409)
                self.assert_no_mutation(before)

    def test_forged_or_excluded_ip_mixed_with_valid_selection_is_all_or_nothing(self):
        self.login()
        network_id = self.network()
        excluded = ['10.88.0.1', '10.88.0.2', '10.88.0.4', '10.88.0.0', '10.88.0.7',
            '10.89.0.3', '::1', 'not-an-ip']
        self.cache_scan(network_id, self.scan_result(('10.88.0.3', *excluded)))
        for forged in [*excluded, '10.88.0.6']:
            with self.subTest(forged=forged):
                before = self.snapshot()
                self.assertEqual(self.save(network_id, ['10.88.0.3', forged]).status_code, 400)
                self.assert_no_mutation(before)

    def test_save_rolls_back_all_pcs_and_audits_on_mid_batch_database_conflict(self):
        self.login()
        network_id = self.network()
        self.cache_scan(network_id)
        before = self.snapshot()
        original_flush = m.db.session.flush

        def conflicting_flush(*args, **kwargs):
            if any(isinstance(row, m.PC) and row.lan_ip == '10.88.0.5' for row in m.db.session.new):
                raise m.IntegrityError('mock concurrent PC insert', {}, RuntimeError('duplicate'))
            return original_flush(*args, **kwargs)

        with patch.object(m.db.session, 'flush', side_effect=conflicting_flush):
            response = self.save(network_id, ['10.88.0.3', '10.88.0.5'])
        self.assertEqual(response.status_code, 409)
        self.assert_no_mutation(before)

    def test_save_and_command_reject_missing_or_unknown_network_without_mutation(self):
        self.login()
        self.network()
        pc_id = self.pc()
        for value, status in (('', 400), ('bad', 400), ('999999', 404)):
            with self.subTest(network_id=value):
                before = self.snapshot()
                self.assertEqual(self.save(value, ['10.88.0.3']).status_code, status)
                response = self.client.post('/dean/pc-command', data={'csrf_token': TOKEN,
                    'network_id': value, 'pc_id': pc_id, 'command': 'lock'})
                self.assertEqual(response.status_code, status)
                self.assert_no_mutation(before)

    def test_save_rejects_changed_interface_snapshot(self):
        self.login()
        network_id = self.network()
        self.cache_scan(network_id)
        self.io['parse_ipv4_interfaces'].return_value = [{'ipv4': '10.88.0.6'}]
        before = self.snapshot()
        self.assertEqual(self.save(network_id, ['10.88.0.3']).status_code, 409)
        self.assert_no_mutation(before)

    def test_commands_allow_admin_and_dean_and_preserve_network_selection(self):
        network_id, pc_id = self.network(), self.pc()
        for role in ('administrator', 'dean'):
            self.login(role)
            for command in ('lock', 'restart', 'shutdown', 'wake'):
                with self.subTest(role=role, command=command):
                    self.io['send_lan_command'].reset_mock()
                    response = self.client.post('/dean/pc-command', data={'csrf_token': TOKEN,
                        'network_id': network_id, 'pc_id': pc_id, 'command': command})
                    self.assert_redirect_network(response, network_id)
                    self.io['send_lan_command'].assert_called_once_with('Approved-PC', command,
                        {'requested_by': 'network-' + role, 'reason': 'Dean remote control'})
        self.assertEqual(len(self.rows(m.AdminLog)), 8)

    def test_command_rejects_wrong_subnet_gateway_local_unknown_pc_and_command(self):
        self.login('dean')
        network_id = self.network()
        good_id = self.pc()
        invalid_ids = [self.pc('Foreign-PC', '10.89.0.3'), self.pc('Gateway-PC', '10.88.0.1'),
            self.pc('Local-PC', '10.88.0.4'), self.pc('Unassigned-PC', None), 999999]
        for pc_id, command in [(pc_id, 'lock') for pc_id in invalid_ids] + [(good_id, 'delete')]:
            with self.subTest(pc_id=pc_id, command=command):
                before = self.snapshot()
                response = self.client.post('/dean/pc-command', data={'csrf_token': TOKEN,
                    'network_id': network_id, 'pc_id': pc_id, 'command': command})
                self.assertEqual(response.status_code, 400)
                self.assert_no_mutation(before)

    def test_agent_token_precedes_payload_validation_and_mutation(self):
        self.network()
        self.pc()
        before = self.snapshot()
        for payload in ([], {'pc_name': 'Approved-PC', 'lan_ip': '10.88.0.3'}):
            self.assertEqual(self.register(payload, token='wrong').status_code, 401)
            self.assert_no_mutation(before)

    def test_known_agent_name_updates_heartbeat_and_can_change_ip_in_saved_subnet(self):
        self.network()
        old = datetime.now() - timedelta(days=1)
        self.pc(last_agent_seen_at=old, online_since_at=old, room='A Lab')
        for ip in ('10.88.0.3', '10.88.0.5'):
            with self.subTest(ip=ip):
                response = self.register({'pc_name': 'Approved-PC', 'lan_ip': ip, 'agent_port': 5002})
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                row, = self.rows(m.PC)
                self.assertEqual((row['name'], row['lan_ip'], row['lan_port'], row['room']),
                    ('Approved-PC', ip, 5002, 'A Lab'))
                self.assertGreater(row['last_agent_seen_at'], old)
                self.assertIsNotNone(row['online_since_at'])

    def test_known_agent_can_use_request_ip_when_ip_is_omitted(self):
        self.network()
        self.pc()
        response = self.register({'pc_name': 'Approved-PC'})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        row, = self.rows(m.PC)
        self.assertEqual(row['lan_ip'], '10.88.0.3')
        self.assertIsNotNone(row['last_agent_seen_at'])

    def test_saved_ip_fallback_keeps_admin_assigned_pc_name(self):
        self.network()
        self.pc()
        response = self.register({'pc_name': 'different-agent-hostname', 'lan_ip': '10.88.0.3', 'agent_port': 5002})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        row, = self.rows(m.PC)
        self.assertEqual(row['name'], 'Approved-PC')
        self.assertEqual(row['lan_port'], 5002)
        self.assertIsNotNone(row['last_agent_seen_at'])

    def test_unknown_agent_requires_admin_approval_without_creating_pc_or_audit(self):
        self.network()
        before = self.snapshot()
        response = self.register({'pc_name': 'Unknown-Agent', 'lan_ip': '10.88.0.3', 'agent_port': 5001})
        self.assertEqual(response.status_code, 403, response.get_data(as_text=True))
        self.assertIn('admin', response.get_json()['error'].lower())
        self.assert_no_mutation(before)

    def test_conflicting_named_pc_and_ip_or_duplicate_saved_ip_rejected(self):
        self.network()
        self.pc()
        self.pc('Other-PC', '10.88.0.5')
        before = self.snapshot()
        response = self.register({'pc_name': 'Approved-PC', 'lan_ip': '10.88.0.5'})
        self.assertEqual(response.status_code, 409)
        self.assert_no_mutation(before)
        self.pc('Duplicate-IP-PC', '10.88.0.3')
        before = self.snapshot()
        for name in ('Approved-PC', 'new-hostname'):
            response = self.register({'pc_name': name, 'lan_ip': '10.88.0.3'})
            self.assertEqual(response.status_code, 409)
            self.assert_no_mutation(before)

    def test_invalid_agent_json_name_ip_or_port_does_not_mutate_even_known_pc(self):
        self.network()
        self.pc()
        valid = {'pc_name': 'Approved-PC', 'lan_ip': '10.88.0.3', 'agent_port': 5001}
        payloads = [[], ['not-an-object'], 'not-an-object', 42, {},
            *[dict(valid, pc_name=value) for value in ('', '   ', None, [], {})],
            *[dict(valid, lan_ip=value) for value in ('bad', '', None, {}, [], '127.0.0.1', '0.0.0.0', '224.0.0.1')],
            *[dict(valid, agent_port=value) for value in (0, -1, 65536, 'bad', None, [], {}, 1.5, True)]]
        for payload in payloads:
            with self.subTest(payload=payload):
                before = self.snapshot()
                response = self.register(payload)
                self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
                self.assert_no_mutation(before)
        before = self.snapshot()
        response = self.client.post('/api/agent/register-lan', data='{broken-json',
            content_type='application/json', headers={'X-Agent-Token': AGENT_TOKEN})
        self.assertEqual(response.status_code, 400)
        self.assert_no_mutation(before)

    def test_invalid_unknown_agent_input_never_leaves_partial_rows(self):
        self.network()
        before = self.snapshot()
        for invalid in ({'lan_ip': 'bad'}, {'agent_port': 0}):
            response = self.register({'pc_name': 'Unknown-Agent', 'lan_ip': '10.88.0.3',
                'agent_port': 5001, **invalid})
            self.assertEqual(response.status_code, 400)
            self.assert_no_mutation(before)

    def test_known_agent_cannot_move_outside_saved_subnet_or_onto_gateway_or_reserved_address(self):
        self.network()
        self.network('B Lab', '10.89.0.0/29', '10.89.0.1')
        self.pc(room='A Lab')
        for ip in ('10.89.0.3', '10.88.0.1', '10.89.0.1', '10.88.0.0', '10.88.0.7'):
            with self.subTest(ip=ip):
                before = self.snapshot()
                response = self.register({'pc_name': 'Approved-PC', 'lan_ip': ip})
                # Address validation may reject with 400 or require reapproval with 403.
                self.assertIn(response.status_code, (400, 403))
                self.assert_no_mutation(before)

    def test_unmapped_known_agent_excludes_saved_gateway_even_if_not_os_gateway(self):
        self.network()
        self.pc(ip=None)
        before = self.snapshot()
        self.assertEqual(self.register({'pc_name': 'Approved-PC', 'lan_ip': '10.88.0.1'}).status_code, 400)
        self.assert_no_mutation(before)
        response = self.register({'pc_name': 'Approved-PC', 'lan_ip': '10.88.0.3'})
        self.assertEqual(response.status_code, 200)
        row, = self.rows(m.PC)
        self.assertEqual(row['room'], 'A Lab')
        self.assertIsNotNone(row['last_agent_seen_at'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
