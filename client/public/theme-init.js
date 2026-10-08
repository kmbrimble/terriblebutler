// Applies the saved theme before first paint to avoid a flash. Kept as a blocking external
// script (not inline) so the Content-Security-Policy needs no 'unsafe-inline' or script hash.
if ((localStorage.getItem('tb_theme') || 'dark') === 'dark') {
  document.documentElement.classList.add('dark');
}
