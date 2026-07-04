import type { ReactNode } from "react"

// Nested layout for /docs/* — a sidebar inside the root chrome (layout chain: root → docs → page).
// Grouped + ordered for a first-time reader: get a backend running, add a frontend, harden it, ship
// it, migrate into it.
const GROUPS: ReadonlyArray<{ title: string; links: ReadonlyArray<{ href: string; label: string }> }> = [
  {
    title: "Start here",
    links: [
      { href: "/docs", label: "Getting started" },
      { href: "/docs/contract", label: "Framework contract" },
      { href: "/docs/api", label: "API & typed client" },
      { href: "/docs/types-first", label: "Types-first" },
      { href: "/docs/database", label: "Database" },
      { href: "/docs/comparison", label: "vs other frameworks" },
    ],
  },
  {
    title: "Frontend",
    links: [
      { href: "/docs/frameworks", label: "Frameworks" },
      { href: "/docs/routing", label: "Routing" },
      { href: "/docs/data", label: "Loaders & actions" },
      { href: "/docs/backends", label: "Backends & API" },
      { href: "/docs/mutations", label: "Optimistic UI" },
      { href: "/docs/query", label: "Query cache" },
      { href: "/docs/streaming", label: "Streaming" },
      { href: "/docs/hydration", label: "Hydration" },
      { href: "/docs/content", label: "Content & MDX" },
      { href: "/docs/images", label: "Images" },
      { href: "/docs/fonts", label: "Fonts" },
      { href: "/docs/i18n", label: "i18n" },
    ],
  },
  {
    title: "Production",
    links: [
      { href: "/docs/auth", label: "Auth & sessions" },
      { href: "/docs/security", label: "Security & uploads" },
      { href: "/docs/plugins", label: "Plugins & middleware" },
      { href: "/docs/edge", label: "Edge & bindings" },
      { href: "/docs/websockets", label: "WebSockets" },
    ],
  },
  {
    title: "Build & deploy",
    links: [
      { href: "/docs/rendering", label: "SSG & ISR" },
      { href: "/docs/dev", label: "Dev & HMR" },
      { href: "/docs/cli", label: "CLI" },
      { href: "/docs/deployment", label: "Deployment" },
      { href: "/docs/troubleshooting", label: "Troubleshooting" },
    ],
  },
  {
    title: "Migrate",
    links: [
      { href: "/docs/migrate-frontend", label: "From Next, Nuxt, SvelteKit" },
      { href: "/docs/migrate-backend", label: "From Express, Hono, Fastify" },
    ],
  },
]

const NAV_SCRIPT = `(function(){
  // 1. Mark active link + Breadcrumbs
  var GROUPS = ${JSON.stringify(GROUPS)};
  function mark(){
    var p = location.pathname;
    var activeLink = null;
    var activeGroupTitle = "";
    
    document.querySelectorAll('.docs-side a[href]').forEach(function(a){
      var isActive = a.getAttribute('href') === p || (p === '/docs/' && a.getAttribute('href') === '/docs');
      a.classList.toggle('active', isActive);
      if (isActive) {
        activeLink = a;
      }
    });

    if (activeLink) {
      var groupNode = activeLink.closest('.nav-group');
      if (groupNode) {
        var titleNode = groupNode.querySelector('.nav-group-title');
        if (titleNode) activeGroupTitle = titleNode.textContent;
      }
      var label = activeLink.textContent;
      var crumbs = document.getElementById('docs-breadcrumbs');
      if (crumbs) {
        crumbs.innerHTML = '<span class="crumb-sec">Docs</span> <span class="crumb-sep">/</span> <span class="crumb-sec">' + activeGroupTitle + '</span> <span class="crumb-sep">/</span> <span class="crumb-active">' + label + '</span>';
      }
    } else {
      var crumbs = document.getElementById('docs-breadcrumbs');
      if (crumbs) crumbs.innerHTML = '<span class="crumb-sec">Docs</span>';
    }
  }

  // 2. Alert formatting
  function formatAlerts() {
    document.querySelectorAll('.prose blockquote').forEach(function(bq) {
      if (bq.dataset.formatted) return;
      var html = bq.innerHTML.trim();
      var match = /^\\s*\\[!(NOTE|TIP|WARNING|CAUTION)\\]\\s*(<br\\/?>)?\\s*([\\s\\S]*)$/i.exec(html);
      if (match) {
        var type = match[1].toUpperCase();
        var content = match[3];
        bq.className = 'alert-callout ' + type.toLowerCase();
        bq.dataset.formatted = "true";
        
        var iconMap = {
          NOTE: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="alert-icon"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
          TIP: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="alert-icon"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .6 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path><line x1="9" y1="18" x2="15" y2="18"></line><line x1="10" y1="22" x2="14" y2="22"></line></svg>',
          WARNING: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="alert-icon"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
          CAUTION: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="alert-icon"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>'
        };

        bq.innerHTML = '<div class="alert-head">' + iconMap[type] + ' <strong>' + type + '</strong></div><div class="alert-body">' + content + '</div>';
      }
    });
  }

  // 3. MacOS-Style Code Windows & Copy Buttons
  function decorateCodeBlocks() {
    document.querySelectorAll('.prose pre.code').forEach(function(pre) {
      if (pre.parentNode.classList.contains('code-window')) return;
      
      // Wrap in code-window
      var wrapper = document.createElement("div");
      wrapper.className = "code-window";
      
      // Determine language
      var lang = "TS";
      var codeNode = pre.querySelector("code");
      if (codeNode) {
        var classes = codeNode.className || "";
        var match = /language-(\\w+)/.exec(classes);
        if (match) {
          lang = match[1].toUpperCase();
        } else if (pre.textContent.trim().startsWith("bun") || pre.textContent.trim().startsWith("npx") || pre.textContent.trim().startsWith("npm") || pre.textContent.trim().startsWith("git")) {
          lang = "Shell";
        }
      }
      
      var header = document.createElement("div");
      header.className = "code-window-header";
      header.innerHTML = '<div class="code-window-dots"><div class="code-window-dot red"></div><div class="code-window-dot yellow"></div><div class="code-window-dot green"></div></div><div class="code-window-lang">' + lang + '</div>';
      
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);

      // Copy button
      if (pre.querySelector('.code-copy-btn')) return;
      var btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.type = "button";
      btn.ariaLabel = "Copy code";
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="copy-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span class="copied-toast">Copied!</span>';
      
      btn.addEventListener("click", function() {
        if (!codeNode) return;
        var code = codeNode.innerText;
        navigator.clipboard.writeText(code);
        btn.classList.add("copied");
        setTimeout(function() { btn.classList.remove("copied"); }, 1500);
      });
      pre.style.position = "relative";
      pre.appendChild(btn);
    });
  }

  // 4. Feed AI Agent Copier
  function setupAgentFeed() {
    var feedBtn = document.getElementById("feed-agent-btn");
    if (!feedBtn) return;
    
    feedBtn.addEventListener("click", function() {
      var p = location.pathname;
      var activeLabel = "Getting started";
      var activeGroup = "Start here";
      
      document.querySelectorAll('.docs-side a.active').forEach(function(a) {
        activeLabel = a.textContent;
        var groupNode = a.closest('.nav-group');
        if (groupNode) {
          var titleNode = groupNode.querySelector('.nav-group-title');
          if (titleNode) activeGroup = titleNode.textContent;
        }
      });

      var proseNode = document.querySelector(".prose");
      var proseText = proseNode ? proseNode.innerText : "";
      
      var contextText = "You are coding in Nifra, the AI-Native TypeScript Framework.\\n" +
        "Current Topic: " + activeLabel + " (" + activeGroup + ")\\n\\n" +
        "Nifra System Constraints:\\n" +
        "1. Never hand-roll fetch() wrappers. Always communicate via the typed client: client<typeof app>(url).\\n" +
        "2. Define schemas (t) at request boundaries to reject bad queries/bodies with 422s before route handlers run.\\n" +
        "3. Route loaders run in-process on the server during SSR (no network/HTTP required). Keep endpoints decoupled.\\n" +
        "4. Never import server-only code (e.g. Bun, Drizzle backend instances) at the top-level of client page routes.\\n\\n" +
        "Documentation and Reference Code:\\n" +
        "=================================\\n" +
        proseText;
        
      navigator.clipboard.writeText(contextText);
      feedBtn.classList.add("copied");
      var textSpan = feedBtn.querySelector(".btn-text");
      if (textSpan) textSpan.textContent = "Copied context!";
      setTimeout(function() {
        feedBtn.classList.remove("copied");
        if (textSpan) textSpan.textContent = "Feed AI Agent";
      }, 1500);
    });
  }

  // 5. Dynamic Table of Contents (TOC)
  var tocObserver = null;
  function setupTOC() {
    var tocNav = document.getElementById("docs-toc-nav");
    if (!tocNav) return;
    tocNav.innerHTML = "";

    var shell = document.querySelector(".docs-shell");
    var headers = document.querySelectorAll(".prose h2");
    if (headers.length === 0) {
      // No headings on this page — collapse the right column so the grid stays balanced.
      if (shell) shell.classList.add("no-toc");
      return;
    }
    if (shell) shell.classList.remove("no-toc");

    var headerElements = [];
    headers.forEach(function(h2, index) {
      if (!h2.id) {
        h2.id = "doc-section-" + index;
      }
      headerElements.push(h2);

      var a = document.createElement("a");
      a.href = "#" + h2.id;
      a.textContent = h2.textContent;
      a.dataset.targetId = h2.id;
      
      a.addEventListener("click", function(e) {
        e.preventDefault();
        h2.scrollIntoView({ behavior: "smooth" });
        history.pushState(null, "", "#" + h2.id);
        
        document.querySelectorAll("#docs-toc-nav a").forEach(function(lnk) {
          lnk.classList.toggle("active", lnk === a);
        });
      });
      tocNav.appendChild(a);
    });

    if (tocObserver) tocObserver.disconnect();
    if ("IntersectionObserver" in window) {
      var activeId = "";
      tocObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            activeId = entry.target.id;
          }
        });
        if (activeId) {
          document.querySelectorAll("#docs-toc-nav a").forEach(function(a) {
            a.classList.toggle("active", a.dataset.targetId === activeId);
          });
        }
      }, {
        rootMargin: "-100px 0px -70% 0px",
        threshold: 0
      });

      headerElements.forEach(function(h2) {
        tocObserver.observe(h2);
      });
    }
  }

  // 6. Connect Search Input to Nifra Bot
  function setupSearch() {
    var searchInput = document.getElementById("docs-search-input");
    if (!searchInput) return;

    searchInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        var query = searchInput.value.trim();
        if (!query) return;
        searchInput.value = "";

        var botButton = document.getElementById("nifra-bot");
        var botContainer = document.getElementById("nifra-bot-container");
        if (botContainer && botContainer.dataset.open !== "true") {
          if (botButton) botButton.click();
        }
        
        setTimeout(function() {
          var botInput = document.getElementById("nifra-bot-input");
          var botForm = document.getElementById("nifra-bot-form");
          if (botInput && botForm) {
            botInput.value = query;
            if (botForm.requestSubmit) {
              botForm.requestSubmit();
            } else {
              botForm.dispatchEvent(new Event("submit"));
            }
            botInput.focus();
          }
        }, 120);
      }
    });
  }

  function init() {
    mark();
    formatAlerts();
    decorateCodeBlocks();
    setupAgentFeed();
    setupTOC();
    setupSearch();
  }

  // Listeners
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  
  window.addEventListener('popstate', function() {
    setTimeout(init, 50);
  });
  
  document.addEventListener('click', function(e) {
    var a = e.target.closest&&e.target.closest('.docs-side a[href]');
    if (a) setTimeout(init, 100);
  });
})();`

export default function DocsLayout(props: { children?: ReactNode }) {
  return (
    <div className="docs-shell">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted static nav highlighter. */}
      <script dangerouslySetInnerHTML={{ __html: NAV_SCRIPT }} />
      <aside className="docs-side">
        <div className="docs-search-container">
          <input type="search" id="docs-search-input" placeholder="Ask AI or search docs..." autoComplete="off" />
        </div>
        <nav>
          {GROUPS.map((group) => (
            <div className="nav-group" key={group.title}>
              <span className="nav-group-title">{group.title}</span>
              {group.links.map((l) => (
                <a key={l.href} href={l.href}>
                  {l.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="docs-main">
        <div className="docs-topbar">
          <div className="docs-breadcrumbs" id="docs-breadcrumbs">
            <span className="crumb-sec">Docs</span>
          </div>
          <div className="docs-actions">
            <button id="feed-agent-btn" className="feed-agent-btn" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-icon" width="16" height="16">
                <rect x="3" y="11" width="18" height="10" rx="2"></rect>
                <circle cx="12" cy="5" r="2"></circle>
                <path d="M12 7v4M8 15h.01M16 15h.01"></path>
              </svg>
              <span className="btn-text">Feed AI Agent</span>
            </button>
          </div>
        </div>
        {props.children}
      </div>
      <aside className="docs-toc" id="docs-toc-container">
        <div className="toc-title">On this page</div>
        <nav id="docs-toc-nav"></nav>
      </aside>
    </div>
  )
}
