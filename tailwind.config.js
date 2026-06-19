/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Cyberpunk HUD palette — deep navy canvas with neon cyan/magenta
        // accents. Token names mirror the original Linear/Vercel scheme so
        // every existing component picks up the new look automatically.
        bg: {
          DEFAULT: '#040714',
          raised: '#0a0f24',
          surface: '#0d1530',
          hover: '#162042',
        },
        border: {
          DEFAULT: '#1f2c5c',
          subtle: '#172146',
          strong: '#2f4392',
        },
        fg: {
          DEFAULT: '#e8f1ff',
          muted: '#8da4cf',
          subtle: '#5d6f99',
        },
        accent: {
          DEFAULT: '#00e5ff',
          soft: '#073445',
        },
        neon: {
          cyan: '#00e5ff',
          magenta: '#ff3df0',
          violet: '#a855ff',
          lime: '#a8ff3d',
        },
        positive: '#39ff9f',
        negative: '#ff4d6d',
        warning: '#ffb547',
      },
      fontFamily: {
        // Body + UI text: Rajdhani has a slight techno feel without being
        // unreadable. Falls back to Inter / system sans.
        sans: [
          'Rajdhani',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        // Big display numbers + the HUD wordmark.
        display: [
          'Orbitron',
          'Rajdhani',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      letterSpacing: {
        hud: '0.18em',
      },
      boxShadow: {
        // Subtle inner highlight + drop — the calm fallback.
        surface:
          '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 1px 2px rgba(0,0,0,0.4)',
        // Neon halos. Use sparingly on hover / active states.
        neon: '0 0 12px rgba(0, 229, 255, 0.45), 0 0 28px rgba(0, 229, 255, 0.18)',
        'neon-soft':
          '0 0 6px rgba(0, 229, 255, 0.35), 0 0 18px rgba(0, 229, 255, 0.12)',
        'neon-magenta':
          '0 0 12px rgba(255, 61, 240, 0.5), 0 0 28px rgba(255, 61, 240, 0.18)',
        'neon-lime':
          '0 0 12px rgba(168, 255, 61, 0.5), 0 0 24px rgba(168, 255, 61, 0.18)',
        hud:
          '0 0 0 1px rgba(0, 229, 255, 0.35), 0 0 24px -8px rgba(0, 229, 255, 0.4), 0 12px 32px -16px rgba(0, 0, 0, 0.7)',
      },
      backgroundImage: {
        // Faint scanlines overlay — applied to the page root.
        scanlines:
          'repeating-linear-gradient(to bottom, rgba(255,255,255,0.025) 0, rgba(255,255,255,0.025) 1px, transparent 1px, transparent 3px)',
        // Holographic dot grid for the page canvas.
        'hud-grid':
          'linear-gradient(rgba(0, 229, 255, 0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 229, 255, 0.06) 1px, transparent 1px)',
        // Diagonal sheen used on titles / tape.
        'hud-sheen':
          'linear-gradient(120deg, transparent 0%, rgba(0,229,255,0.12) 40%, rgba(255,61,240,0.12) 60%, transparent 100%)',
      },
      backgroundSize: {
        grid: '32px 32px',
      },
      keyframes: {
        'row-in': {
          '0%': {
            opacity: '0',
            transform: 'translateY(-6px)',
            backgroundColor: 'rgba(0, 229, 255, 0.16)',
          },
          '60%': {
            opacity: '1',
            transform: 'translateY(0)',
            backgroundColor: 'rgba(0, 229, 255, 0.16)',
          },
          '100%': {
            opacity: '1',
            transform: 'translateY(0)',
            backgroundColor: 'transparent',
          },
        },
        'pulse-soft': {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        // Cyan glow that breathes — used on active HUD chrome.
        'glow-pulse': {
          '0%,100%': {
            boxShadow:
              '0 0 6px rgba(0,229,255,0.35), 0 0 18px rgba(0,229,255,0.12)',
          },
          '50%': {
            boxShadow:
              '0 0 14px rgba(0,229,255,0.6), 0 0 32px rgba(0,229,255,0.25)',
          },
        },
        // CRT-style flicker on the wordmark.
        flicker: {
          '0%,19%,21%,23%,25%,54%,56%,100%': { opacity: '1' },
          '20%,24%,55%': { opacity: '0.55' },
        },
        // Slow pan of a scanline sweeping the canvas.
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        // Background grid drift — barely noticeable but adds life.
        'grid-drift': {
          '0%': { backgroundPosition: '0 0, 0 0' },
          '100%': { backgroundPosition: '32px 32px, 32px 32px' },
        },
        // Ticker dot blink.
        blink: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.2' },
        },
      },
      animation: {
        'row-in': 'row-in 1.2s ease-out',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'glow-pulse': 'glow-pulse 2.4s ease-in-out infinite',
        flicker: 'flicker 4s steps(1, end) infinite',
        scan: 'scan 7s linear infinite',
        'grid-drift': 'grid-drift 18s linear infinite',
        blink: 'blink 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
