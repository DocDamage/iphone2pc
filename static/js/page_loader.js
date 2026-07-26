const pageFragments = [
    "header", "navigation", "home", "music", "drive", "recovery", "fabric", "safety", "help", "player"
];
const controllerScripts = [
    "ui_utils", "shell_ui", "dashboard_ui", "music_scan", "music_library", "player", "drive_browser",
    "drive_operations", "intelligence", "recovery_queue_ui",
    "sync_companion_ui", "deep_diagnostics_ui", "fabric_ui", "app"
];
function loadClassicScript(name) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `js/${name}.js`;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Could not load ${name}.js`));
        document.body.appendChild(script);
    });
}
async function bootstrapPage() {
    const responses = await Promise.all(pageFragments.map(name => fetch(`partials/${name}.html`)));
    if (responses.some(response => !response.ok)) throw new Error("One or more UI fragments could not be loaded.");
    const fragments = await Promise.all(responses.map(response => response.text()));
    const [header, navigation, ...content] = fragments;
    const player = content.pop();
    document.getElementById("appShell").innerHTML = header +
        `<div class="workspace-shell">${navigation}<main id="mainContent" class="app-container" tabindex="-1">${content.join("")}</main></div>` +
        player;
    for (const script of controllerScripts) await loadClassicScript(script);
    initializeApp();
}
bootstrapPage().catch(error => {
    document.getElementById("appShell").innerHTML =
        `<main style="padding:32px;color:#ef4444">Unable to start iDrivePulse: ${error.message}</main>`;
});
