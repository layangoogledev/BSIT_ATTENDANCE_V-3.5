// Shared UI helpers for index.html (student/admin tab switcher).
// Split out of student-app.js so the login page doesn't depend on
// student-only auth logic just to switch tabs.

window.switchTab = (tab) => {
  document.getElementById('student-section').classList.toggle('hidden', tab !== 'student');
  document.getElementById('admin-section').classList.toggle('hidden', tab !== 'admin');
  document.getElementById('tab-student').classList.toggle('active', tab === 'student');
  document.getElementById('tab-admin').classList.toggle('active', tab === 'admin');
};

window.setAuthMode = (mode) => {
  const isSignup = mode === 'signup';
  document.getElementById('signup-fields').classList.toggle('hidden', !isSignup);
  document.getElementById('btn-login-mode').classList.toggle('active', !isSignup);
  document.getElementById('btn-signup-mode').classList.toggle('active', isSignup);
  document.getElementById('btn-student-submit').innerText = isSignup ? 'Enroll & Register' : 'Sign In';
};
