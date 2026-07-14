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

// Intersection observer for subtle reveal animations, staggered within each section
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
        // Clear the stagger delay once revealed so hover transitions stay snappy
        setTimeout(() => {
          entry.target.style.transitionDelay = '';
        }, 900);
      }
    });
  },
  {
    threshold: 0.15,
  }
);

const revealCounts = new Map();
document
  .querySelectorAll('.stat-card, .event-card, .ministry-card, .sermon-card, .team-card, .gallery-item')
  .forEach((element) => {
    const section = element.closest('section');
    const index = revealCounts.get(section) || 0;
    revealCounts.set(section, index + 1);
    element.classList.add('will-reveal');
    element.style.transitionDelay = `${Math.min(index * 70, 420)}ms`;
    observer.observe(element);
  });

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Countdown to the next Sunday worship gathering (Sundays, 10:30am local)
const countdownEls = {
  days: document.getElementById('cdDays'),
  hours: document.getElementById('cdHours'),
  mins: document.getElementById('cdMins'),
  secs: document.getElementById('cdSecs'),
};

const nextServiceDate = () => {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + ((7 - now.getDay()) % 7));
  next.setHours(10, 30, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 7);
  }
  return next;
};

const updateCountdown = () => {
  if (!countdownEls.days) return;
  const diff = nextServiceDate() - new Date();
  const secs = Math.floor(diff / 1000);
  countdownEls.days.textContent = Math.floor(secs / 86400);
  countdownEls.hours.textContent = String(Math.floor((secs % 86400) / 3600)).padStart(2, '0');
  countdownEls.mins.textContent = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  countdownEls.secs.textContent = String(secs % 60).padStart(2, '0');
};

if (countdownEls.days) {
  updateCountdown();
  setInterval(updateCountdown, 1000);
}

// "Live Now" badge during the Sunday service window (10:15am–11:45am)
const liveBadge = document.getElementById('liveBadge');

const updateLiveBadge = () => {
  if (!liveBadge) return;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const isLive = now.getDay() === 0 && minutes >= 10 * 60 + 15 && minutes <= 11 * 60 + 45;
  liveBadge.classList.toggle('d-none', !isLive);
};

updateLiveBadge();
setInterval(updateLiveBadge, 60000);

// Hero background parallax
const heroBgImg = document.querySelector('.hero-bg img');
if (heroBgImg && !prefersReducedMotion) {
  window.addEventListener(
    'scroll',
    () => {
      const y = Math.min(window.scrollY, 900);
      heroBgImg.style.transform = `translateY(${y * 0.22}px)`;
    },
    { passive: true }
  );
}

// Gallery lightbox
const lightboxImg = document.getElementById('lightboxImg');
document.querySelectorAll('.gallery-item').forEach((item) => {
  item.addEventListener('click', () => {
    if (!lightboxImg || typeof bootstrap === 'undefined') return;
    const thumb = item.querySelector('img');
    lightboxImg.src = item.getAttribute('data-full');
    lightboxImg.alt = thumb ? thumb.alt : '';
    bootstrap.Modal.getOrCreateInstance('#lightboxModal').show();
  });
});

// "Find your next step" finder
const NEXT_STEPS = {
  new: {
    title: 'Join us this Sunday at 10:30am',
    text: "No pressure and no expectations — come as you are, grab a coffee, and stop by the Welcome Center. We'd love to save you a seat.",
    cta: { label: 'Plan Your Visit', href: '#contact' },
  },
  kids: {
    title: 'Check out Kids & Student ministries',
    text: 'Kids from birth through 5th grade have a safe, fun class every Sunday, and students in grades 6-12 gather weekly for worship and small groups.',
    cta: { label: 'Explore Ministries', href: '#ministries' },
  },
  community: {
    title: 'Join a Community Group',
    text: 'Groups meet in homes around Erlanger every Wednesday to share meals, study Scripture, and do life together. There is a group for every life stage.',
    cta: { label: 'Find a Group', href: '#events' },
  },
  serve: {
    title: 'Serve with the Care Team',
    text: 'From the Hope Pantry to City Serve Saturdays, there are hands-on ways to love our neighbors every month. Training is provided for new volunteers.',
    cta: { label: 'Volunteer', href: '#contact' },
  },
};

const nextStepOptions = document.getElementById('nextStepOptions');
const nextStepResult = document.getElementById('nextStepResult');

if (nextStepOptions && nextStepResult) {
  nextStepOptions.querySelectorAll('[data-step]').forEach((button) => {
    button.addEventListener('click', () => {
      const step = NEXT_STEPS[button.getAttribute('data-step')];
      if (!step) return;
      document.getElementById('nextStepTitle').textContent = step.title;
      document.getElementById('nextStepText').textContent = step.text;
      const cta = document.getElementById('nextStepCta');
      cta.textContent = step.cta.label;
      cta.setAttribute('href', step.cta.href);
      nextStepOptions.classList.add('d-none');
      nextStepResult.classList.remove('d-none');
    });
  });

  document.getElementById('nextStepReset').addEventListener('click', () => {
    nextStepResult.classList.add('d-none');
    nextStepOptions.classList.remove('d-none');
  });
}
