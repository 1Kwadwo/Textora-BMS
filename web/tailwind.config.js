/** KebSEND web theme. Build with `npm run build:css` (outputs public/style.css). */
const brandBlue = {
  50: '#EEF4FD', 100: '#DAE6FA', 200: '#B6CDF4', 300: '#86ABEB', 400: '#4F83E0',
  500: '#2D6CDB', 600: '#1F5FD6', 700: '#1A4FB5', 800: '#163F8F', 900: '#0A2A66', 950: '#061A40'
}

module.exports = {
  content: ['./public/**/*.{html,js}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // `blue` is remapped to the KebSEND brand blue so every blue-* utility stays on-brand.
        blue: brandBlue,
        navy: { ...brandBlue, DEFAULT: '#0A2A66' },
        ember: {
          50: '#FFF4EB', 100: '#FFE4CC', 200: '#FFC699', 300: '#FFA866', 400: '#FF8A2A',
          500: '#FF6A00', 600: '#E65C00', 700: '#BF4C00', 800: '#8F3900', 900: '#5C2500', DEFAULT: '#FF6A00'
        },
        teal: {
          50: '#E8FAF7', 100: '#C6F2EC', 200: '#8FE4D9', 300: '#55D3C4', 400: '#26C2B0',
          500: '#12B3A1', 600: '#0E9384', 700: '#0B7469', 800: '#08564E', 900: '#053833', DEFAULT: '#12B3A1'
        },
        cream: { 50: '#FFFBF7', 100: '#FFF6EE', 200: '#FFEBDA', 300: '#FFDDBF' },
        ink: '#5B6B85',
        night: { 800: '#0F2550', 850: '#0C1F45', 900: '#0A1A3A', 950: '#071430' }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace']
      },
      boxShadow: {
        soft: '0 1px 2px rgba(10,42,102,.04), 0 12px 32px -12px rgba(10,42,102,.18)',
        chip: '0 10px 30px -10px rgba(10,42,102,.35)',
        ember: '0 10px 24px -8px rgba(255,106,0,.55)'
      }
    }
  },
  plugins: [require('daisyui')],
  daisyui: {
    logs: false,
    themes: [
      {
        light: {
          primary: '#FF6A00', 'primary-content': '#ffffff',
          secondary: '#1F5FD6', 'secondary-content': '#ffffff',
          accent: '#12B3A1', 'accent-content': '#ffffff',
          neutral: '#0A2A66', 'neutral-content': '#ffffff',
          'base-100': '#ffffff', 'base-200': '#FFF6EE', 'base-300': '#F0E4D8', 'base-content': '#0A2A66',
          info: '#1F5FD6', success: '#12B3A1', 'success-content': '#ffffff', warning: '#F5B400', error: '#E5484D', 'error-content': '#ffffff',
          '--rounded-box': '1.25rem', '--rounded-btn': '0.75rem', '--rounded-badge': '9999px',
          '--btn-text-case': 'none', '--animation-btn': '0.2s'
        }
      },
      {
        dark: {
          primary: '#FF7A1A', 'primary-content': '#ffffff',
          secondary: '#4F83E0', 'secondary-content': '#ffffff',
          accent: '#26C2B0', 'accent-content': '#06211E',
          neutral: '#0F2550', 'neutral-content': '#E8EEF9',
          'base-100': '#0C1F45', 'base-200': '#0A1A3A', 'base-300': '#16306A', 'base-content': '#E8EEF9',
          info: '#4F83E0', success: '#26C2B0', 'success-content': '#06211E', warning: '#F5B400', error: '#F06A6E', 'error-content': '#ffffff',
          '--rounded-box': '1.25rem', '--rounded-btn': '0.75rem', '--rounded-badge': '9999px',
          '--btn-text-case': 'none', '--animation-btn': '0.2s'
        }
      }
    ]
  }
}
