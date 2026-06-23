import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // True-black OLED base with a cool, near-neutral surface ramp.
        ink: {
          950: '#000000',
          900: '#060608',
          850: '#0b0b0f',
          800: '#111116',
          700: '#1a1a22',
          600: '#26262f',
          500: '#3a3a45',
        },
        fog: {
          50: '#f7f7fb',
          100: '#ececf2',
          300: '#b9b9c6',
          400: '#9292a3',
          500: '#6f6f81',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          soft: 'rgb(var(--accent) / 0.14)',
          glow: 'rgb(var(--accent) / 0.45)',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        brand: ['var(--font-brand)', 'var(--font-display)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        '4xl': '2rem',
      },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--accent) / 0.4), 0 8px 40px -8px rgb(var(--accent) / 0.5)',
        lift: '0 24px 60px -20px rgba(0,0,0,0.85)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-soft': {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-soft': 'pulse-soft 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
