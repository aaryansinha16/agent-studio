/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Palette per PRODUCT_VISION.md — dark theme + cyan accent.
        ink: {
          950: '#0A0E14',
          900: '#0F141C',
          800: '#141A23',
          700: '#1B2230',
          600: '#252D3D',
          500: '#3A4458',
        },
        accent: {
          DEFAULT: '#4ECDC4',
          soft: '#7CE2DB',
          deep: '#2BAFA6',
        },
        agent: {
          idle: '#6B7A8F',
          planning: '#A78BFA',
          coding: '#4ECDC4',
          testing: '#FBBF24',
          blocked: '#F87171',
          error: '#EF4444',
          communicating: '#60A5FA',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['Instrument Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 24px rgba(78, 205, 196, 0.25)',
      },
    },
  },
  plugins: [],
}
