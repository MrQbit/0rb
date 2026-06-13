(() => {
  'use strict';

  if (window.parent !== window) {
    document.documentElement.classList.add('embedded');
  }
  window.addEventListener('DOMContentLoaded', () => {
    if (window.parent !== window) {
      document.body.classList.add('embedded');
    }
    const backBtn = document.getElementById('backToConsole');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        window.location.href = '/';
      });
    }
  });
})();
