// Frontend configuration. No secrets belong here: this file is public.
window.AEVY_CONFIG = {
  // Same-domain Worker route (recommended): leave as "/api".
  // Separate Worker domain: "https://aevycpm-api.<your-subdomain>.workers.dev/api"
  API_BASE: '/api',
  // Optional Cloudflare Turnstile site key (public). Leave empty to disable.
  TURNSTILE_SITE_KEY: ''
};
