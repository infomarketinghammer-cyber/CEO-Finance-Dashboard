/**
 * DHYEYA design tokens.
 *
 * Colours are sampled from the supplied logo: the deep navy of the wordmark, the
 * electric blue and cyan of the ring, and the mint green of its highlight. The
 * gradient is reserved for the logo lock-up, active navigation and a single
 * featured metric — a financial table is harder to read when everything glows.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#10264A',
          50: '#F2F5FA',
          100: '#E3E9F4',
          200: '#C3CFE6',
          300: '#94A8CF',
          400: '#5D78AE',
          500: '#365390',
          600: '#1F3A6E',
          700: '#17305E',
          800: '#12294F',
          900: '#10264A',
          950: '#0A1931',
        },
        brand: {
          DEFAULT: '#0878F9',
          50: '#EFF6FF',
          100: '#DCEBFE',
          200: '#BEDBFE',
          300: '#92C3FD',
          400: '#5FA3FB',
          500: '#0878F9',
          600: '#0063DB',
          700: '#004FB1',
          800: '#064291',
          900: '#0A3978',
        },
        cyan: {
          DEFAULT: '#13C6D9',
          50: '#ECFDFF',
          100: '#CFF9FE',
          200: '#A5F1FC',
          300: '#67E4F9',
          400: '#22CEEE',
          500: '#13C6D9',
          600: '#0892B0',
          700: '#0E748F',
          800: '#155E74',
          900: '#164E62',
        },
        mint: {
          DEFAULT: '#48E6A0',
          50: '#EDFDF5',
          100: '#D4F9E6',
          200: '#ACF1D1',
          300: '#48E6A0',
          400: '#2FD18C',
          500: '#13B574',
          600: '#09925D',
          700: '#0A744D',
          800: '#0C5C40',
          900: '#0B4B36',
        },
        page: '#F6F8FC',
        surface: '#FFFFFF',
        ink: {
          DEFAULT: '#17243B',
          muted: '#68758A',
          subtle: '#94A1B4',
        },
        line: {
          DEFAULT: '#E4EAF2',
          strong: '#CFD8E6',
        },
        positive: { DEFAULT: '#0F8A5F', bg: '#E8F8F1', border: '#B6E6D1' },
        warning: { DEFAULT: '#B45309', bg: '#FEF6E7', border: '#F5DCA9' },
        danger: { DEFAULT: '#B91C1C', bg: '#FEF0F0', border: '#F6C9C9' },
        info: { DEFAULT: '#0063DB', bg: '#EFF6FF', border: '#C3DDFC' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        card: '0.75rem',
        control: '0.5rem',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(16, 38, 74, 0.04), 0 1px 3px 0 rgba(16, 38, 74, 0.06)',
        'card-hover': '0 4px 12px -2px rgba(16, 38, 74, 0.10), 0 2px 6px -2px rgba(16, 38, 74, 0.06)',
        dropdown: '0 10px 32px -8px rgba(16, 38, 74, 0.20), 0 4px 12px -4px rgba(16, 38, 74, 0.10)',
        focus: '0 0 0 3px rgba(8, 120, 249, 0.18)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(118deg, #0878F9 0%, #13C6D9 58%, #48E6A0 100%)',
        'navy-gradient': 'linear-gradient(160deg, #10264A 0%, #17305E 100%)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-in': 'fade-in 140ms ease-out',
        'slide-up': 'slide-up 180ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
