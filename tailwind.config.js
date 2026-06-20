/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Avalanche-style palette — near-black canvas, Avalanche red accent,
        // clean neutral grays. Token names mirror the original scheme so
        // every existing component picks up the new look automatically.
        bg: {
          DEFAULT: '#050505',
          raised: '#0E0A0B',
          surface: '#120C0D',
          hover: '#1C1315',
        },
        border: {
          DEFAULT: '#3A2022',
          subtle: '#241517',
          strong: '#5A2E30',
        },
        fg: {
          DEFAULT: '#F5F3F3',
          muted: '#A39A9B',
          subtle: '#6E6566',
        },
        accent: {
          DEFAULT: '#E84142', // Avalanche red
          soft: '#2A1314',
        },
        neon: {
          cyan: '#E84142',
          magenta: '#FF6B5B',
          violet: '#F5A623',
          lime: '#2FCC71',
        },
        positive: '#2FCC71',
        negative: '#FF5A5F',
        warning: '#F5A623',
      },
      fontFamily: {
        // Clean modern sans — Inter, falling back to the system UI stack.
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        // Display = the same clean sans (no more techno Orbitron).
        display: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
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
        hud: '0.08em',
      },
      boxShadow: {
        surface:
          '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px rgba(0,0,0,0.5)',
        // Soft red halos — used sparingly on hover / active states.
        neon: '0 0 12px rgba(232,65,66,0.35), 0 0 28px rgba(232,65,66,0.12)',
        'neon-soft':
          '0 0 6px rgba(232,65,66,0.28), 0 0 16px rgba(232,65,66,0.10)',
        'neon-magenta':
          '0 0 12px rgba(255,107,91,0.40), 0 0 24px rgba(255,107,91,0.14)',
        'neon-lime':
          '0 0 12px rgba(47,204,113,0.40), 0 0 22px rgba(47,204,113,0.14)',
        hud:
          '0 0 0 1px rgba(255,255,255,0.05), 0 12px 32px -16px rgba(0,0,0,0.7)',
      },
      backgroundImage: {
        scanlines:
          'repeating-linear-gradient(to bottom, rgba(255,255,255,0.015) 0, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 3px)',
        // Faint neutral dot grid for the page canvas.
        'hud-grid':
          'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
        'hud-sheen':
          'linear-gradient(120deg, transparent 0%, rgba(232,65,66,0.10) 50%, transparent 100%)',
      },
      backgroundSize: {
        grid: '32px 32px',
      },
      keyframes: {
        'row-in': {
          '0%': {
            opacity: '0',
            transform: 'translateY(-6px)',
            backgroundColor: 'rgba(232,65,66,0.14)',
          },
          '60%': {
            opacity: '1',
            transform: 'translateY(0)',
            backgroundColor: 'rgba(232,65,66,0.14)',
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
        'glow-pulse': {
          '0%,100%': {
            boxShadow:
              '0 0 6px rgba(232,65,66,0.32), 0 0 16px rgba(232,65,66,0.12)',
          },
          '50%': {
            boxShadow:
              '0 0 12px rgba(232,65,66,0.5), 0 0 28px rgba(232,65,66,0.2)',
          },
        },
        flicker: {
          '0%,19%,21%,23%,25%,54%,56%,100%': { opacity: '1' },
          '20%,24%,55%': { opacity: '0.55' },
        },
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        'grid-drift': {
          '0%': { backgroundPosition: '0 0, 0 0' },
          '100%': { backgroundPosition: '32px 32px, 32px 32px' },
        },
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
