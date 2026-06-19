/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Linear/Vercel-leaning neutrals — flat, low-contrast surfaces over a
        // near-black canvas. Avoid heavy gradients in components.
        bg: {
          DEFAULT: '#08090a',
          raised: '#0e1011',
          surface: '#15171a',
          hover: '#1c1f23',
        },
        border: {
          DEFAULT: '#1f2226',
          subtle: '#191b1f',
          strong: '#2a2e34',
        },
        fg: {
          DEFAULT: '#e6e8eb',
          muted: '#9aa2ad',
          subtle: '#6b7280',
        },
        accent: {
          DEFAULT: '#7c5cff',
          soft: '#3b2f7a',
        },
        positive: '#3ecf8e',
        negative: '#f87171',
        warning: '#f5a524',
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
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
      boxShadow: {
        surface: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px rgba(0,0,0,0.4)',
      },
      keyframes: {
        'row-in': {
          '0%': {
            opacity: '0',
            transform: 'translateY(-6px)',
            backgroundColor: 'rgba(124, 92, 255, 0.12)',
          },
          '60%': {
            opacity: '1',
            transform: 'translateY(0)',
            backgroundColor: 'rgba(124, 92, 255, 0.12)',
          },
          '100%': {
            opacity: '1',
            transform: 'translateY(0)',
            backgroundColor: 'transparent',
          },
        },
        'pulse-soft': {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
      },
      animation: {
        'row-in': 'row-in 1.2s ease-out',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
