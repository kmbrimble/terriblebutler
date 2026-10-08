// Pixel Art has one deliberate dark-only palette (see its index.css). Flag it so MenuDrawer
// hides the Dark Mode toggle instead of rendering a no-op control. External for CSP, as theme-init.js.
document.documentElement.classList.add('dark');
document.documentElement.dataset.themeLocked = 'true';
