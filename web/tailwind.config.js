/** KebSEND web theme. Build with `npm run build:css` (outputs public/style.css). */
// "Market" palette: deep green, gold, terracotta on warm cream.
// The old token names (navy, blue, ember, teal, cream) are kept so existing markup restyles in place.
const green = {
  50: '#EAF4EF', 100: '#D3E8DD', 200: '#A7D0BB', 300: '#73B293', 400: '#3D8B6E',
  500: '#23775A', 600: '#1A6A4F', 700: '#145C44', 800: '#11533D', 900: '#0F4D3A', 950: '#0B3B2C'
}

module.exports = {
  content: ['./public/**/*.{html,js}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        blue: green,
        navy: { ...green, DEFAULT: '#0F4D3A' },
        gold: { 50: '#FDF5E3', 100: '#FAE8BF', 200: '#F5D58A', 300: '#F0C055', 400: '#ECB12F', 500: '#E8A317', 600: '#C98A0B', 700: '#9E6C08', DEFAULT: '#E8A317' },
        ember: {
          50: '#FBEEEA', 100: '#F6DAD2', 200: '#EDB5A6', 300: '#E28F7A', 400: '#D66F57',
          500: '#C8553D', 600: '#B14630', 700: '#923926', 800: '#6F2B1D', 900: '#4A1D13', DEFAULT: '#C8553D'
        },
        teal: {
          50: '#E9F5EE', 100: '#CDE9D9', 200: '#9DD3B5', 300: '#69BA8E', 400: '#43A06F',
          500: '#2E8B5A', 600: '#24744A', 700: '#1C5D3B', 800: '#15472D', 900: '#0E311F', DEFAULT: '#2E8B5A'
        },
        cream: { 50: '#FBF5EC', 100: '#F6EBDC', 200: '#EFDFC8', 300: '#E6CFAF' },
        ink: '#6E6457',
        night: { 800: '#1A3B30', 850: '#15322A', 900: '#112A23', 950: '#0C201A' }
      },
      fontFamily: {
        sans: ['Bricolage Grotesque', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace']
      },
      boxShadow: {
        soft: '0 1px 0 rgba(29,26,22,.06)',
        chip: '0 2px 0 rgba(29,26,22,.08)',
        ember: 'none'
      }
    }
  },
  plugins: [require('daisyui')],
  daisyui: {
    logs: false,
    themes: [
      {
        light: {
          primary: '#C8553D', 'primary-content': '#ffffff',
          secondary: '#0F4D3A', 'secondary-content': '#ffffff',
          accent: '#E8A317', 'accent-content': '#ffffff',
          neutral: '#0F4D3A', 'neutral-content': '#ffffff',
          'base-100': '#ffffff', 'base-200': '#F6EBDC', 'base-300': '#EFDFC8', 'base-content': '#1D1A16',
          info: '#1A6A4F', success: '#2E8B5A', 'success-content': '#ffffff', warning: '#F5B400', error: '#E5484D', 'error-content': '#ffffff',
          '--rounded-box': '1.25rem', '--rounded-btn': '9999px', '--rounded-badge': '9999px',
          '--btn-text-case': 'none', '--animation-btn': '0.2s'
        }
      },
      {
        dark: {
          primary: '#D66F57', 'primary-content': '#ffffff',
          secondary: '#73B293', 'secondary-content': '#ffffff',
          accent: '#ECB12F', 'accent-content': '#1D1A16',
          neutral: '#1A3B30', 'neutral-content': '#F6EBDC',
          'base-100': '#15322A', 'base-200': '#112A23', 'base-300': '#244A3D', 'base-content': '#F6EBDC',
          info: '#73B293', success: '#43A06F', 'success-content': '#06211E', warning: '#F5B400', error: '#F06A6E', 'error-content': '#ffffff',
          '--rounded-box': '1.25rem', '--rounded-btn': '9999px', '--rounded-badge': '9999px',
          '--btn-text-case': 'none', '--animation-btn': '0.2s'
        }
      }
    ]
  }
}
