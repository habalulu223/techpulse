        function wireAdminProfileTabs() {
            var tabs = document.querySelectorAll('[data-admin-tab-target]');
            if (!tabs.length) {
                return;
            }

            tabs.forEach(function (tab) {
                tab.addEventListener('click', function () {
                    tabs.forEach(function (candidate) {
                        var panel = document.getElementById(candidate.dataset.adminTabTarget);
                        var active = candidate === tab;
                        candidate.classList.toggle('active', active);
                        candidate.setAttribute('aria-selected', active ? 'true' : 'false');
                        if (panel) {
                            panel.hidden = !active;
                        }
                    });
                });
            });
        }

        wireAdminProfileTabs();

        // Handle system terminate button
        let terminateSysBtn = document.getElementById('terminate-sys-btn');
        if (terminateSysBtn) {
            terminateSysBtn.addEventListener('click', function() {
                if (confirm('WARNING: This will close the client app!\n\nContinue?')) {
                    if (confirm('Are you ABSOLUTELY SURE? The client app will close!')) {
                        fetch('/admin/terminate-system', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            }
                        })
                        .then(response => response.json())
                        .then(data => {
                            if (data.ok) {
                                alert(data.message);
                                // Close the app by calling the JavaScript API if available
                                if (typeof window.pywebview !== 'undefined' && window.pywebview.api) {
                                    window.pywebview.api.terminate('PYPONDO_TERMINATE_2026').then(result => {
                                        if (!result) {
                                            console.log('Terminating app...');
                                            window.close();
                                        }
                                    });
                                } else {
                                    // Fallback for non-pywebview mode
                                    window.close();
                                }
                            } else {
                                alert('Error: ' + (data.error || 'Failed to terminate app'));
                            }
                        })
                        .catch(error => {
                            console.error('Error:', error);
                            alert('Error: Failed to send terminate command');
                        });
                    }
                }
            });
        }

    
