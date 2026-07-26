let playerTrackIndex = -1;

function playTrackFromBtn(button) {
    const track = currentTracks.find(item => item.id === button.dataset.trackId);
    if (track) playTrack(track);
}

function playTrack(track) {
    const audio = document.getElementById("audioElement");
    const sameTrack = activePlayingTrackId === track.id;
    playerTrackIndex = currentTracks.findIndex(item => item.id === track.id);
    activePlayingTrackId = track.id;
    const player = document.getElementById("audioPlayerBar");
    player.classList.remove("is-idle", "collapsed");
    if (!sameTrack) audio.src = `/api/music/stream/${encodeURIComponent(track.id)}`;
    document.getElementById("playerTitle").textContent = track.title || track.original_filename || "Unknown";
    document.getElementById("playerArtist").textContent = track.artist || track.album || "Recovered from iPhone";
    audio.play().catch(error => showToast("error", "Playback Failed", error.message));
}

function togglePlayPause() {
    const audio = document.getElementById("audioElement");
    if (!audio.src && currentTracks.length) return playTrack(currentTracks[0]);
    audio.paused ? audio.play() : audio.pause();
}

function nextTrack() {
    if (!currentTracks.length) return;
    playerTrackIndex = (Math.max(playerTrackIndex, -1) + 1) % currentTracks.length;
    playTrack(currentTracks[playerTrackIndex]);
}

function prevTrack() {
    if (!currentTracks.length) return;
    playerTrackIndex = (playerTrackIndex <= 0 ? currentTracks.length : playerTrackIndex) - 1;
    playTrack(currentTracks[playerTrackIndex]);
}

function setupAudioListeners() {
    const audio = document.getElementById("audioElement");
    audio.addEventListener("play", () => setPlayerIcon("pause"));
    audio.addEventListener("pause", () => setPlayerIcon("play"));
    audio.addEventListener("ended", nextTrack);
    audio.addEventListener("loadedmetadata", updatePlayerProgress);
    audio.addEventListener("timeupdate", updatePlayerProgress);
    document.getElementById("audioPlayerBar").classList.toggle("collapsed", localStorage.getItem("idrivepulse_player_collapsed") === "1");
}

function togglePlayerBar() {
    const player = document.getElementById("audioPlayerBar");
    player.classList.toggle("collapsed");
    localStorage.setItem("idrivepulse_player_collapsed", player.classList.contains("collapsed") ? "1" : "0");
}

function setPlayerIcon(icon) {
    const node = document.querySelector("#btnPlayPause i");
    if (node) node.className = `fa-solid fa-${icon}`;
}

function updatePlayerProgress() {
    const audio = document.getElementById("audioElement");
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    document.getElementById("playerProgressFill").style.width = `${duration ? audio.currentTime / duration * 100 : 0}%`;
    document.getElementById("playerCurrentTime").textContent = formatTime(audio.currentTime);
    document.getElementById("playerTotalTime").textContent = formatTime(duration);
}

function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function seekTrack(event) {
    const audio = document.getElementById("audioElement");
    if (!Number.isFinite(audio.duration)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * audio.duration;
}

function changeVolume(value) {
    const audio = document.getElementById("audioElement");
    audio.volume = Number(value);
    audio.muted = false;
    document.getElementById("volumeIcon").className = `fa-solid fa-volume-${audio.volume ? "high" : "xmark"}`;
}

function toggleMute() {
    const audio = document.getElementById("audioElement");
    audio.muted = !audio.muted;
    document.getElementById("volumeIcon").className = `fa-solid fa-volume-${audio.muted ? "xmark" : "high"}`;
}

function changePlaybackSpeed(value) {
    document.getElementById("audioElement").playbackRate = Number(value);
}

function setupKeyboardShortcuts() {
    document.addEventListener("keydown", event => {
        if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
        if (event.target.closest(".nav-tabs, dialog")) return;
        if (event.code === "Space") { event.preventDefault(); togglePlayPause(); }
        if (event.key === "ArrowRight") nextTrack();
        if (event.key === "ArrowLeft") prevTrack();
        if (event.ctrlKey && event.key.toLowerCase() === "s") { event.preventDefault(); scanMusicSSE(); }
    });
}
