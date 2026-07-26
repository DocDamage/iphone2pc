const workspaceCommands = [
    {title: "Home", detail: "Open your recovery command center", icon: "fa-house", run: () => navigateTo("homeTab")},
    {title: "Recover beats", detail: "Scan, preview, select, and copy music", icon: "fa-music", run: () => navigateTo("musicTab")},
    {title: "Browse iPhone files", detail: "Explore everything iOS exposes", icon: "fa-folder-open", run: () => navigateTo("driveTab")},
    {title: "Recovery queue", detail: "Resume transfers and view verification", icon: "fa-list-check", run: () => navigateTo("recoveryTab")},
    {title: "Recovery Fabric", detail: "Backup fusion, Beat DNA, vault, and provenance", icon: "fa-diagram-project", run: () => navigateTo("fabricTab")},
    {title: "Device & safety", detail: "Drivers, kernel, registry, USB, and access limits", icon: "fa-shield-halved", run: () => navigateTo("wifiTab")},
    {title: "Setup guide", detail: "Connection help and keyboard shortcuts", icon: "fa-circle-question", run: () => navigateTo("helpTab")},
    {title: "Scan iPhone now", detail: "Start a deep music scan", icon: "fa-wave-square", run: () => startHomeScan()},
    {title: "Reconnect iPhone", detail: "Create a fresh trusted USB session", icon: "fa-rotate-right", run: () => forceReconnect()},
    {title: "Switch appearance", detail: "Toggle light and dark theme", icon: "fa-sun", run: () => toggleTheme()},
    {title: "Guided recovery tour", detail: "Review the three-step workflow", icon: "fa-compass", run: () => openWelcome()},
];

let visibleCommands = [...workspaceCommands];
let commandSelection = 0;

function initializeShell() {
    const savedTheme = localStorage.getItem("idrivepulse_theme") || "dark";
    document.body.dataset.theme = savedTheme;
    document.body.classList.toggle("compact", localStorage.getItem("idrivepulse_density") === "compact");
    updateAppearanceButtons();
    document.querySelectorAll(".nav-tab").forEach(button => {
        button.id = `nav_${button.dataset.tab}`;
        const panel = document.getElementById(button.dataset.tab);
        if (panel) { panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", button.id); }
    });
    renderCommands();
    setupShellKeyboard();
    setupTabKeyboard();
    const requested = location.hash.replace("#", "");
    const valid = document.querySelector(`.nav-tab[data-tab="${CSS.escape(requested)}"]`);
    navigateTo(valid ? requested : "homeTab", {history: "replace"});
    window.addEventListener("popstate", () => {
        const target = location.hash.replace("#", "") || "homeTab";
        if (document.getElementById(target)) navigateTo(target, {history: false});
    });
}

function navigateTo(tabId, options = {}) {
    const button = document.querySelector(`.nav-tab[data-tab="${CSS.escape(tabId)}"]`);
    if (!button) return;
    switchTab(tabId, button, options);
}

function activateWorkspaceTab(tabId, button, options = {}) {
    document.querySelectorAll(".tab-content").forEach(tab => {
        const active = tab.id === tabId;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-hidden", String(!active));
    });
    document.querySelectorAll(".nav-tab").forEach(tab => {
        const active = tab === button;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
    });
    const label = button.querySelector("span:nth-child(2)")?.textContent?.trim() || "Workspace";
    document.title = `${label} · iDrivePulse`;
    if (options.history !== false) {
        const method = options.history === "replace" ? "replaceState" : "pushState";
        history[method]({tabId}, "", `#${tabId}`);
    }
    closeSidebar();
    if (options.focus) document.getElementById("mainContent")?.focus({preventScroll: true});
    window.scrollTo({top: 0, behavior: "smooth"});
}

function toggleSidebar() {
    const open = !document.body.classList.contains("sidebar-open");
    document.body.classList.toggle("sidebar-open", open);
    document.getElementById("sidebarToggle").setAttribute("aria-expanded", String(open));
}

function closeSidebar() {
    document.body.classList.remove("sidebar-open");
    document.getElementById("sidebarToggle")?.setAttribute("aria-expanded", "false");
}

function toggleTheme() {
    document.body.dataset.theme = document.body.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem("idrivepulse_theme", document.body.dataset.theme);
    updateAppearanceButtons();
}

function toggleDensity() {
    document.body.classList.toggle("compact");
    localStorage.setItem("idrivepulse_density", document.body.classList.contains("compact") ? "compact" : "comfortable");
    updateAppearanceButtons();
}

function updateAppearanceButtons() {
    const theme = document.getElementById("themeToggle");
    if (theme) theme.innerHTML = document.body.dataset.theme === "light"
        ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    const density = document.getElementById("densityToggle");
    if (density) density.classList.toggle("is-active", document.body.classList.contains("compact"));
}

function openCommandPalette() {
    const dialog = document.getElementById("commandPalette");
    if (!dialog.open) dialog.showModal();
    const input = document.getElementById("commandInput");
    input.value = "";
    filterCommands("");
    requestAnimationFrame(() => input.focus());
}

function closeCommandPalette() {
    const dialog = document.getElementById("commandPalette");
    if (dialog.open) dialog.close();
}

function filterCommands(query) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    visibleCommands = workspaceCommands.filter(command => words.every(word =>
        `${command.title} ${command.detail}`.toLowerCase().includes(word)
    ));
    commandSelection = 0;
    renderCommands();
}

function renderCommands() {
    const list = document.getElementById("commandList");
    if (!list) return;
    list.innerHTML = visibleCommands.length ? visibleCommands.map((command, index) => `
        <button class="command-item ${index === commandSelection ? "selected" : ""}" type="button" role="option" aria-selected="${index === commandSelection}" data-command-index="${index}">
            <i class="fa-solid ${command.icon}"></i><div><strong>${escapeHtml(command.title)}</strong><small>${escapeHtml(command.detail)}</small></div><i class="fa-solid fa-arrow-turn-down"></i>
        </button>`).join("") : '<div class="empty-state">No matching actions</div>';
    list.querySelectorAll(".command-item").forEach(button => button.addEventListener("click", () => runCommand(Number(button.dataset.commandIndex))));
}

function runCommand(index) {
    const command = visibleCommands[index];
    if (!command) return;
    closeCommandPalette();
    command.run();
}

function setupShellKeyboard() {
    document.addEventListener("keydown", event => {
        const palette = document.getElementById("commandPalette");
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            palette.open ? closeCommandPalette() : openCommandPalette();
            return;
        }
        if (palette.open) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                commandSelection = (commandSelection + direction + visibleCommands.length) % Math.max(visibleCommands.length, 1);
                renderCommands();
                document.querySelector(".command-item.selected")?.scrollIntoView({block: "nearest"});
            } else if (event.key === "Enter") {
                event.preventDefault(); runCommand(commandSelection);
            }
            return;
        }
        const tag = event.target.tagName;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === "1") navigateTo("musicTab");
        if (event.key === "2") navigateTo("driveTab");
        if (event.key === "3") navigateTo("recoveryTab");
    });
    document.getElementById("commandPalette")?.addEventListener("click", event => {
        if (event.target === event.currentTarget) closeCommandPalette();
    });
}

function setupTabKeyboard() {
    document.querySelector(".nav-tabs")?.addEventListener("keydown", event => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        const tabs = [...document.querySelectorAll(".nav-tab")];
        const current = tabs.indexOf(document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        const next = (current + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus();
    });
}

function openWelcome() { document.getElementById("welcomeDialog")?.showModal(); }
function closeWelcome() { document.getElementById("welcomeDialog")?.close(); localStorage.setItem("idrivepulse_welcome_seen", "1"); }
function beginWelcomeRecovery() { closeWelcome(); startGuidedRecovery(); }
