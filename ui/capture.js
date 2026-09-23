/**
 * Injected into draw.io's own index.html, before draw.io boots.
 *
 * draw.io starts itself with `App.main()` once its scripts and the window have
 * loaded (`checkAllLoaded` in js/bootstrap.js). `App.main` takes a callback
 * that receives the editor instance, but the stock page passes none, and the
 * instance is otherwise unreachable. This file makes the same call with a
 * callback, so the canvas page around the editor (same origin, one frame up)
 * can drive it: diff what the person did, merge what the agent did, render
 * screenshots.
 *
 * It is the only change made to draw.io, and it changes nothing draw.io does.
 */
(function () {
	window.checkAllLoaded = function () {
		if (window.mxScriptsLoaded && window.mxWinLoaded) {
			App.main(function (ui) {
				window.drawioCanvasUi = ui;
				if (typeof window.drawioCanvasReady === "function") window.drawioCanvasReady(ui);
			});
		}
	};
})();
