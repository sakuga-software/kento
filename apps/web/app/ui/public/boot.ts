// KNT-163. The one module of every page. It loads the runtime of the components only when the page
// has one to hydrate: the server then writes their props in `<script id="rmx-data">`, and the
// import map that resolves the runtime. A page without a component loads nothing more. The URL of
// the runtime is on the script element (`data-runtime`): it carries the hash of its content.
let runtime = document.querySelector<HTMLScriptElement>('script[data-runtime]')?.dataset.runtime
if (runtime && document.getElementById('rmx-data')) await import(runtime)
