"""Smoke-test that every themed page renders with the calm Techpuls UI assets."""
import os
import shutil
import sys
import tempfile
from unittest.mock import patch

PROJECT = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix='techpuls_ui_test_')

shutil.copy(os.path.join(PROJECT, 'pccafe.db'), os.path.join(tmp, 'pccafe.db'))
os.environ['PYPONDO_DB_PATH'] = os.path.join(tmp, 'pccafe.db')
os.environ['PYPONDO_COMMUNITY_DB_PATH'] = os.path.join(tmp, 'community_equipment.db')
os.environ['PYPONDO_AUTH_DB_PATH'] = os.path.join(tmp, 'auth.db')
os.environ['PYPONDO_SECRET_KEY'] = 'test-secret-key'

sys.path.insert(0, PROJECT)
import app as app_module  # noqa: E402

with app_module.app.app_context():
    app_module.initialize_database()
    from sqlalchemy import text
    user_columns = {row[1] for row in app_module.db.session.execute(text('PRAGMA table_info(user)')).fetchall()}
    payment_table = app_module.db.session.execute(
        text("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_transaction'")
    ).fetchone()
    booking_table = app_module.db.session.execute(
        text("SELECT name FROM sqlite_master WHERE type='table' AND name='booking'")
    ).fetchone()

failures = []


def check(name, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {name}' + (f' - {detail}' if detail and not condition else ''))
    if not condition:
        failures.append(name)


client = app_module.app.test_client()

# Public pages
page = client.get('/login')
check('login renders', page.status_code == 200)
check('login uses theme + Inter', b'professional.css' in page.data and b'family=Inter' in page.data)
page = client.get('/register')
check('register renders', page.status_code == 200)
check('register uses theme + Inter', b'professional.css' in page.data and b'family=Inter' in page.data)

page = client.get('/definitely-not-a-page')
check('error page renders themed', page.status_code == 404 and b'css/error.css' in page.data and b'#16090d' not in page.data)

# Authenticated pages (admin seed account)
client.post('/login', data={'username': 'admin', 'password': 'admin123'})

THEMED_PAGES = {
    '/profile': 'profile',
    '/profile/password': 'change password',
    '/settings': 'settings',
    '/dean/pcs': 'dean',
    '/mobile/pairing': 'mobile pairing',
    '/dashboard': 'role dashboard',
    '/equipment': 'equipment',
    '/logs': 'logs',
}
for path, label in THEMED_PAGES.items():
    with patch.object(app_module, 'get_gateway_client_scan', return_value={
            'ok': False, 'error': 'No test network', 'clients': []}):
        page = client.get(path)
    ok_status = page.status_code == 200
    check(f'{label} renders ({path})', ok_status, f'status {page.status_code}')
    if ok_status:
        check(f'{label} loads theme', b'professional.css' in page.data)
        check(f'{label} loads Inter', b'family=Inter' in page.data)

# Appearance preferences persist on the account and are emitted by the theme include.
page = client.post('/settings', data={'theme': 'dark', 'font_family': 'serif', 'font_size': 'large'}, follow_redirects=True)
check('settings save applies dark/serif/large', b'"dark"' in page.data and b'"serif"' in page.data and b'"large"' in page.data)
page = client.get('/dashboard')
check('preferences apply on other pages', b'"dark"' in page.data and b'"serif"' in page.data and b'"large"' in page.data)
client.post('/settings', data={'theme': 'light', 'font_family': 'inter', 'font_size': 'default'})

# Wallet/payment screens and storage are retired.
check('pondo column dropped', 'pondo' not in user_columns, f'columns: {sorted(user_columns)}')
check('payment table dropped', payment_table is None)
check('booking table dropped', booking_table is None)
for retired_path in ('/admin/payments', '/pondo', '/bookings', '/delete_booking/1', '/client/bookings'):
    page = client.get(retired_path)
    check(f'{retired_path} removed', page.status_code == 404, f'status {page.status_code}')
for retired_path in ('/book', '/api/mobile/book'):
    page = client.post(retired_path)
    check(f'{retired_path} removed', page.status_code == 404, f'status {page.status_code}')
check('mobile bookings removed', client.get('/api/mobile/bookings').status_code == 404)

# /dashboard is role-gated; an account without a staff or borrowing role is redirected.
page = client.get('/dashboard')
check('role dashboard responds', page.status_code in (200, 302), f'status {page.status_code}')
if page.status_code == 200:
    check('role dashboard loads theme', b'professional.css' in page.data)

with app_module.app.app_context():
    dean = app_module.User(username='gateway_dean_test', role='dean')
    dean.set_password('local-test-only')
    app_module.db.session.add(dean)
    app_module.db.session.commit()
    app_module.ensure_auth_database()

summary = {
    'cidr': '10.88.0.0/29', 'gateway_ipv4': '10.88.0.1',
    'local_ipv4': '10.88.0.2', 'subnet_mask': '255.255.255.248',
}
scan = {
    'ok': True, 'client_count': 1, 'stale': False,
    'clients': [{'ip': '10.88.0.3', 'mapped_pc_name': 'Gateway Test PC', 'room': 'Test Lab'}],
}
with patch.object(app_module, 'build_primary_ipv4_network_summary', return_value=summary), \
        patch.object(app_module, 'get_gateway_client_scan', return_value=scan) as discovery:
    page = client.get('/dean/pcs')
    check('admin sees gateway discovery', page.status_code == 200 and b'Gateway Discovery' in page.data)
    client.get('/logout')
    client.post('/login', data={'username': 'gateway_dean_test', 'password': 'local-test-only'})
    page = client.get('/dean/pcs')
    check('dean sees gateway and mapped devices', page.status_code == 200
        and b'10.88.0.1' in page.data and b'Gateway Test PC' in page.data and b'Test Lab' in page.data)
    check('dean discovery is non-blocking', discovery.call_args.kwargs == {'non_blocking': True})
    check('refresh submits a page request', b'action="/dean/pcs#gateway-discovery"' in page.data
        and b'<button type="submit">Refresh discovery</button>' in page.data)
    check('dean cannot use admin-only discovery API', client.get('/api/admin/lan-discovery').status_code == 403)
    discovery.return_value = {'ok': True, 'client_count': 0, 'clients': [], 'stale': True}
    page = client.get('/dean/pcs')
    check('empty discovery explains pending scan', b'No client devices have been detected' in page.data
        and b'Discovery is running in the background' in page.data)
    discovery.return_value = {'ok': False, 'error': 'no active IPv4 router network detected', 'clients': []}
    page = client.get('/dean/pcs')
    check('unavailable discovery shows a useful message', page.status_code == 200
        and b'Gateway discovery unavailable' in page.data and b'Check the server' in page.data)
    discovery.return_value = dict(scan, clients=[{'ip': '10.88.0.3', 'mapped_pc_name': '<script>alert(1)</script>'}])
    page = client.get('/dean/pcs')
    check('discovered device names are escaped', b'&lt;script&gt;alert(1)&lt;/script&gt;' in page.data)
    client.get('/logout')
    discovery.reset_mock()
    check('anonymous users cannot view discovery', client.get('/dean/pcs').status_code == 302)
    check('anonymous requests do not start discovery', not discovery.called)
    with app_module.app.app_context():
        student = app_module.User(username='gateway_access_test', role='student')
        student.set_password('local-test-only')
        app_module.db.session.add(student)
        app_module.db.session.commit()
        app_module.ensure_auth_database()
    client.post('/login', data={'username': 'gateway_access_test', 'password': 'local-test-only'})
    check('students cannot view dean discovery', client.get('/dean/pcs').status_code == 302)
    check('student requests do not start discovery', not discovery.called)

with patch.object(app_module, 'build_primary_ipv4_network_summary', return_value=summary), \
        patch.object(app_module, 'discover_lan_ipv4_neighbors', return_value=['10.88.0.3']), \
        patch.object(app_module, 'ping_ipv4_host', return_value=False), \
        patch.object(app_module, 'reverse_dns_name', return_value='gateway-test.local'), \
        patch.dict(os.environ, {'LAN_SCAN_ENABLE_NETBIOS': '0'}):
    with app_module.LAN_SCAN_LOCK:
        app_module.LAN_SCAN_CACHE.update(result=None, scan_in_progress=True)
    app_module._run_gateway_scan_background()
    result = app_module.LAN_SCAN_CACHE.get('result')
    check('background discovery has database context', bool(result and result.get('ok')))
    check('background discovery caches resolved devices', bool(result and result.get('clients')
        and result['clients'][0]['source_pc_name'] == 'gateway-test'))
    check('background discovery clears running state', not app_module.LAN_SCAN_CACHE['scan_in_progress'])

print()
if failures:
    print(f'{len(failures)} FAILURE(S): {failures}')
    sys.exit(1)
print('All UI smoke tests passed.')
