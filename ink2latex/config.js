// Send mode configuration, shared by the lecturer app and the student viewer.
// Supabase project "TeachingApps" (EU), schema "ink2latex" (see ../supabase-setup.sql).
// The publishable key is public by design: row level security decides who may read or write what.
// Never put the service_role / secret key in any file here.

export const SUPABASE_URL = 'https://waktaohjndbhswareqzk.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_w3U495HfA5hOYZrMUETBpA_uyX7EIgg';
export const SCHEMA = 'ink2latex';

// Public address of this viewer folder: GitHub Pages, repository DEX-2DPHYS/teachingapps, folder
// ink2latex/ (published with ..\publish-viewer.cmd). The QR code and the link in the Send menu point
// here. Empty: the lecturer app links to its own local copy (http://localhost:5178/viewer/), which
// only works on the lecturer's PC or LAN. Moving to DTU web space later = change this line.
export const VIEWER_URL = 'https://dex-2dphys.github.io/teachingapps/ink2latex/';

export const LIBS = {
  supabase: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  qrcode: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm',
  freehand: 'https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.3/+esm',
  katexJs: 'https://cdn.jsdelivr.net/npm/katex@0.18.9/dist/katex.min.js',
  katexCss: 'https://cdn.jsdelivr.net/npm/katex@0.18.9/dist/katex.min.css',
};
