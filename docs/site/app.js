/**
 * 梨园 (Liyuan v1.6.4) 说明文档站交互脚本
 * 包含：明暗主题切换、双语偏好记忆、移动端抽屉、滚动监听高亮、全屏灯箱、一键代码复制与返回顶部
 */

(function () {
  "use strict";

  // ---------- 1. 主题切换 (Theme Toggle) ----------
  const THEME_KEY = "liyuan-doc-theme";
  const themeToggleBtn = document.getElementById("themeToggle");

  function getPreferredTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    if (themeToggleBtn) {
      const textSpan = themeToggleBtn.querySelector(".theme-text");
      if (textSpan) {
        const isZh = document.documentElement.lang.startsWith("zh");
        textSpan.textContent = theme === "dark" ? (isZh ? "白天" : "Light") : (isZh ? "黑夜" : "Dark");
      }
    }
  }

  // 初始化主题
  applyTheme(getPreferredTheme());

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      applyTheme(current === "dark" ? "light" : "dark");
    });
  }

  // ---------- 2. 双语偏好记录 (Language Preference) ----------
  const LANG_KEY = "liyuan-doc-lang";
  const currentLang = document.documentElement.lang.startsWith("zh") ? "zh" : "en";
  localStorage.setItem(LANG_KEY, currentLang);

  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      const href = this.getAttribute("href");
      if (href && href.includes("en")) {
        localStorage.setItem(LANG_KEY, "en");
      } else {
        localStorage.setItem(LANG_KEY, "zh");
      }
    });
  });

  // ---------- 3. 移动端菜单抽屉 (Mobile Drawer) ----------
  const mobileToggle = document.getElementById("mobileToggle");
  const sidebar = document.getElementById("sidebar");

  if (mobileToggle && sidebar) {
    mobileToggle.addEventListener("click", () => {
      sidebar.classList.toggle("mobile-open");
    });

    // 点击侧栏链接后自动收起
    sidebar.querySelectorAll(".nav-link").forEach((link) => {
      link.addEventListener("click", () => {
        sidebar.classList.remove("mobile-open");
      });
    });
  }

  // ---------- 4. 滚动监听高亮目录 (ScrollSpy) ----------
  const sections = document.querySelectorAll("section[id], [id^='part3-ui-']");
  const navLinks = document.querySelectorAll(".nav-link");

  if (sections.length > 0 && navLinks.length > 0) {
    const observerOptions = {
      root: null,
      rootMargin: "-20% 0px -70% 0px",
      threshold: 0,
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute("id");
          navLinks.forEach((link) => {
            if (link.getAttribute("href") === `#${id}`) {
              link.classList.add("active");
            } else {
              link.classList.remove("active");
            }
          });
        }
      });
    }, observerOptions);

    sections.forEach((sec) => observer.observe(sec));
  }

  // ---------- 5. 图片全屏灯箱 (Lightbox) ----------
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightboxImg");
  const lightboxClose = document.getElementById("lightboxClose");

  function openLightbox(src, alt) {
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src;
    lightboxImg.alt = alt || "截图大图";
    lightbox.classList.add("active");
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove("active");
    document.body.style.overflow = "";
  }

  document.querySelectorAll(".screen-img-wrap").forEach((wrap) => {
    wrap.addEventListener("click", () => {
      const img = wrap.querySelector("img");
      if (img) openLightbox(img.src, img.alt);
    });
  });

  if (lightbox) {
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox || e.target === lightboxClose) {
        closeLightbox();
      }
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  // ---------- 6. 代码块一键复制 (Copy Code) ----------
  const isZh = document.documentElement.lang.startsWith("zh");
  const copyLabel = isZh ? "复制" : "Copy";
  const copiedLabel = isZh ? "已复制" : "Copied";
  const failLabel = isZh ? "失败" : "Failed";

  document.querySelectorAll("pre").forEach((pre) => {
    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = copyLabel;
    btn.setAttribute("aria-label", copyLabel);

    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      const text = code ? code.innerText : pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = copiedLabel;
        btn.style.color = "var(--accent)";
        setTimeout(() => {
          btn.textContent = copyLabel;
          btn.style.color = "";
        }, 2000);
      } catch (err) {
        btn.textContent = failLabel;
      }
    });

    pre.appendChild(btn);
  });

  // ---------- 7. 返回顶部按钮 (Back to Top) ----------
  const backToTopBtn = document.getElementById("backToTop");
  if (backToTopBtn) {
    window.addEventListener("scroll", () => {
      if (window.scrollY > 400) {
        backToTopBtn.classList.add("visible");
      } else {
        backToTopBtn.classList.remove("visible");
      }
    });

    backToTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
})();
