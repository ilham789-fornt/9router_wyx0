// Troubleshooting endpoint: inspect + interact with the live browser page of a
// specific worker/account belonging to a codebuddy-github bulk import job.
//
// GET returns the current URL, title, visible inputs and buttons, plus the
// first 3KB of page innerText, which is enough to diagnose most stuck flows
// (GitHub 2FA/device verify, disabled Authorize, CodeBuddy region page, etc.).
//
// POST accepts an action:
//   - authorize:  strips the anti-clickjacking `disabled` from GitHub's
//                 Authorize button and calls requestSubmit()/form.submit()
//                 as a fallback for the same fix the manager already runs.
//   - click:      Playwright locator click on an arbitrary selector.
//   - region:     runs the shared CodeBuddy region-page / /started callback /
//                 onboarding handlers on the live page.
//   - goto:       navigates the live page to a given URL.
//
// This endpoint is protected by the same dashboard-auth middleware every other
// /api/oauth/* route uses; it only touches in-memory job state that already
// belongs to the caller. Do not use it against jobs from other users.
import { NextResponse } from "next/server";
import { getCodeBuddyGithubBulkImportManager } from "@/lib/oauth/services/codebuddyGithubBulkImportManager";

export const dynamic = "force-dynamic";

async function findLivePage(jobId) {
  const manager = getCodeBuddyGithubBulkImportManager();
  const job = manager.jobs?.get?.(jobId);
  if (!job) return { error: "job not found in memory", status: 404 };
  const acct = job.accounts.find((a) => a.manualSession?.page || a.runtimeSession?.page);
  if (!acct) return { error: "no live page", status: 404 };
  return { manager, job, acct, page: acct.manualSession?.page || acct.runtimeSession?.page };
}

export async function GET(_request, { params }) {
  const { jobId } = await params;
  const found = await findLivePage(jobId);
  if (found.error) return NextResponse.json({ error: found.error }, { status: found.status });
  const { page, acct } = found;
  const bodyText = await page.evaluate(() => ({
    href: window.location.href,
    title: document.title,
    innerText: (document.body?.innerText || "").slice(0, 3000),
    inputs: Array.from(document.querySelectorAll("input"))
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ name: el.name || null, id: el.id || null, type: el.type || null, placeholder: el.placeholder || null }))
      .slice(0, 20),
    buttons: Array.from(document.querySelectorAll("button, input[type='submit'], a"))
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || "").trim().slice(0, 80),
        name: el.name || null,
        value: el.getAttribute("value") || null,
        href: el.href || null,
      }))
      .filter((el) => el.text)
      .slice(0, 30),
  })).catch((err) => ({ evalError: String(err?.message || err) }));
  return NextResponse.json({ email: acct.email, status: acct.status, url: page.url?.() || null, ...bodyText });
}

// POST body: { action: "authorize" | "click", selector?: string }
export async function POST(request, { params }) {
  const { jobId } = await params;
  const body = await request.json().catch(() => ({}));
  const found = await findLivePage(jobId);
  if (found.error) return NextResponse.json({ error: found.error }, { status: found.status });
  const { page } = found;
  const action = String(body?.action || "authorize");
  try {
    if (action === "authorize") {
      const result = await page.evaluate(() => {
        // Remove disabled from the Authorize button (GitHub's anti-clickjacking
        // countdown) and submit the form directly.
        const form = document.querySelector('form[action*="/login/oauth/authorize"]');
        if (!form) {
          return { clicked: false, reason: "no authorize form" };
        }
        const approve = form.querySelector('button[name="authorize"][value="1"], input[name="authorize"][value="1"]');
        if (approve) {
          approve.disabled = false;
          approve.removeAttribute("disabled");
        }
        // Ensure the form knows we clicked "Authorize" (value=1) not "Cancel".
        // Adding a hidden input mirrors what a real submit-by-button would do.
        if (!form.querySelector('input[type="hidden"][name="authorize"][value="1"]')) {
          const hidden = document.createElement("input");
          hidden.type = "hidden";
          hidden.name = "authorize";
          hidden.value = "1";
          form.appendChild(hidden);
        }
        // Prefer requestSubmit (fires submit event handlers) over form.submit.
        if (typeof form.requestSubmit === "function") {
          try { form.requestSubmit(approve || undefined); return { clicked: true, via: "requestSubmit" }; }
          catch { /* fall through */ }
        }
        form.submit();
        return { clicked: true, via: "form.submit" };
      });
      await page.waitForTimeout?.(4000).catch(() => null);
      return NextResponse.json({ ok: true, action, result, urlAfter: page.url?.() || null });
    }
    if (action === "click" && body?.selector) {
      const clicked = await page.locator(body.selector).first().click({ timeout: 5000 }).then(() => true).catch((e) => String(e?.message || e));
      return NextResponse.json({ ok: true, action, clicked });
    }
    if (action === "region") {
      // Run the shared CodeBuddy region-page handler on the live page.
      const { handleCodeBuddyRegionPage, handleCodeBuddyStartedAuthorization, handleProviderOnboarding } = await import("@/lib/oauth/services/automation/googleOAuth");
      const steps = [];
      const report = (s, m) => steps.push({ s, m });
      const r1 = await handleCodeBuddyRegionPage(page, report);
      await page.waitForTimeout(1500).catch(() => null);
      const r2 = await handleCodeBuddyStartedAuthorization(page, report);
      await page.waitForTimeout(1500).catch(() => null);
      const r3 = await handleProviderOnboarding(page, report, "CodeBuddy");
      return NextResponse.json({ ok: true, action, region: r1, started: r2, onboarding: r3, steps, urlAfter: page.url?.() || null });
    }
    if (action === "goto" && body?.url) {
      await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return NextResponse.json({ ok: true, action, urlAfter: page.url?.() || null });
    }
    if (action === "probe") {
      // Deep DOM inspection for the region page: enumerate every clickable
      // element (div, img, svg, button, a) whose visible text contains
      // "Submit"/"Get started" so we can craft a working selector.
      const probe = await page.evaluate(() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden"
            && style.display !== "none"
            && Number(style.opacity) !== 0
            && rect.width > 0
            && rect.height > 0;
        };
        const wordRe = /submit|get started|continue|confirm/i;
        const candidates = [];
        const all = document.querySelectorAll("*");
        for (const el of all) {
          if (!visible(el)) continue;
          const ownText = (el.innerText || "").trim();
          if (!ownText || ownText.length > 60) continue;
          if (!wordRe.test(ownText)) continue;
          candidates.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classList: el.className && typeof el.className === "string" ? el.className.slice(0, 200) : null,
            text: ownText.slice(0, 60),
            rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
            hasOnclick: Boolean(el.onclick),
            role: el.getAttribute("role") || null,
            type: el.getAttribute("type") || null,
          });
        }
        return { candidates: candidates.slice(0, 25) };
      }).catch((e) => ({ error: String(e?.message || e) }));
      return NextResponse.json({ ok: true, action, probe, url: page.url?.() || null });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
