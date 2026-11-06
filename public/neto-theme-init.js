// Apply saved appearance before the first app frame; default to the dark NetoAcademy palette.
try {
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.replace('theme--dark', 'theme--light');
    }
} catch {
    // Retain the default appearance when browser storage is unavailable.
}
