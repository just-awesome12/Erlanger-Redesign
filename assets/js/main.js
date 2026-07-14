const yearEl = document.getElementById('year');
if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

// Dark mode toggle (initial theme is set by the inline script in <head>)
const themeToggle = document.getElementById('themeToggle');

const applyThemeToToggle = (theme) => {
  if (!themeToggle) return;
  const icon = themeToggle.querySelector('i');
  if (icon) {
    icon.className = theme === 'dark' ? 'bi bi-sun' : 'bi bi-moon-stars';
  }
  themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
  themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
};

applyThemeToToggle(document.documentElement.getAttribute('data-bs-theme'));

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-bs-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch (e) {
      /* storage unavailable (e.g. private browsing) */
    }
    applyThemeToToggle(next);
  });
}

// Navbar scroll state and back-to-top visibility
const navbar = document.querySelector('.navbar');
const backToTop = document.getElementById('backToTop');

const onScroll = () => {
  const scrolled = window.scrollY > 24;
  if (navbar) {
    navbar.classList.toggle('navbar-scrolled', scrolled);
  }
  if (backToTop) {
    backToTop.classList.toggle('is-visible', window.scrollY > 480);
  }
};

window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

if (backToTop) {
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// Event filtering
document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    const filter = button.getAttribute('data-filter');
    document.querySelectorAll('[data-filter]').forEach((btn) => btn.classList.remove('active'));
    button.classList.add('active');

    document.querySelectorAll('#eventsList [data-category]').forEach((card) => {
      const category = card.getAttribute('data-category');
      if (filter === 'all' || category === filter) {
        card.classList.remove('d-none');
        card.classList.add('fade-in');
      } else {
        card.classList.add('d-none');
        card.classList.remove('fade-in');
      }
    });
  });
});

// Newsletter subscription and contact form demo handling
document.querySelectorAll('form').forEach((form) => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const alert = form.querySelector('.alert');
    if (alert) {
      alert.classList.remove('d-none');
      alert.setAttribute('role', 'alert');
      setTimeout(() => {
        alert.classList.add('d-none');
      }, 4000);
    }
    form.reset();
  });
});

// Intersection observer for subtle reveal animations
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    });
  },
  {
    threshold: 0.2,
  }
);

document.querySelectorAll('.stat-card, .event-card, .ministry-card').forEach((element) => {
  element.classList.add('will-reveal');
  observer.observe(element);
});
