// Show unauthorized error if redirected back with ?error=unauthorized
if (new URLSearchParams(window.location.search).get('error') === 'unauthorized') {
  openModal();
  document.getElementById('modal-error').textContent = 'Access denied. Invalid or expired token.';
}

function openModal() {
  document.getElementById('modal-overlay').classList.add('visible');
  setTimeout(() => document.getElementById('pw-input').focus(), 50);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('visible');
  document.getElementById('pw-input').value = '';
  document.getElementById('modal-error').textContent = '';
}

function togglePw() {
  const input = document.getElementById('pw-input');
  input.type = input.type === 'password' ? 'text' : 'password';
}

// Allow Enter key to submit
document.getElementById('pw-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPassword();
});

// Close modal on overlay click
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

async function submitPassword() {
  const password   = document.getElementById('pw-input').value.trim();
  const errorEl    = document.getElementById('modal-error');
  const confirmBtn = document.getElementById('confirm-btn');

  if (!password) {
    errorEl.textContent = 'Please enter a password.';
    return;
  }

  confirmBtn.disabled    = true;
  confirmBtn.textContent = 'Checking...';
  errorEl.textContent    = '';

  try {
    const res  = await fetch('/verify-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = '❌ Incorrect password. Try again.';
      document.getElementById('pw-input').value = '';
      document.getElementById('pw-input').focus();
    } else {
      // Store token in sessionStorage, then go to /create
      sessionStorage.setItem('adminToken', data.token);
      window.location.href = `/create?token=${data.token}`;
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    confirmBtn.disabled    = false;
    confirmBtn.textContent = 'Continue →';
  }
}
