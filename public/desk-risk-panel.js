(() => {
  "use strict";
  if (window.__VISITOR) return;
  const panel = document.getElementById("deskRiskPanel");
  if (!panel) return;
  const money = (x) => Number.isFinite(x) ? x.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—";
  const add = (parent, tag, label) => {
    const node = document.createElement(tag);
    node.textContent = label;
    parent.append(node);
    return node;
  };
  let pending = false;
  async function draw() {
    if (pending || document.hidden || document.getElementById("tab-aitrade")?.hidden) return;
    pending = true;
    try {
      const response = await fetch("/api/desk-risk", { cache: "no-store" });
      if (!response.ok) return;
      const d = await response.json(), state = d.state;
      panel.hidden = false;
      panel.replaceChildren();
      add(panel, "h4", "Paper desk risk");
      add(panel, "p", d.reason).className = "ap-note";
      const stats = add(panel, "div", "");
      stats.className = "ap-mini";
      for (const [label, value, hint] of [
        ["Combined equity", money(state?.nav), state?.at ? "As of " + new Date(state.at).toLocaleTimeString("en-US", { timeZone: "America/New_York" }) + " ET" : "Waiting for aligned marks"],
        ["Session loss", money(state?.dailyLoss), money(d.policy.hardDaily) + " entry stop · " + (state?.referenceType || "reference pending")],
        ["Peak drawdown", money(state?.drawdown), money(d.policy.peakStop) + " owner-review lock"],
        ["Modeled open risk", money(d.exposure?.stopRisk), money(d.policy.plannedRisk) + " cap on new risk"],
        ["Net SPY beta exposure", money(d.exposure?.betaDollars), "Absolute cap " + Math.round(d.policy.betaFraction * 100) + "% of desk equity"],
      ]) {
        const item = add(stats, "div", "");
        add(item, "span", label);
        add(item, "b", value);
        add(item, "small", hint);
      }
      if (d.error) add(panel, "p", d.error).className = "ap-note";
      if (d.mode === "locked") {
        const button = add(panel, "button", "Review drawdown lock");
        button.type = "button";
        button.addEventListener("click", async () => {
          if (!window.confirm("Resume paper entries if the desk has recovered within both loss limits?")) return;
          const reply = await fetch("/api/desk-risk/review", { method: "POST" });
          if (!reply.ok) window.alert("The desk stays locked until recent marks are available and both loss limits are clear.");
          await draw();
        });
      }
    } catch {
      if (!panel.hidden) {
        panel.replaceChildren();
        add(panel, "p", "Desk risk status temporarily unavailable.");
      }
    } finally { pending = false; }
  }
  draw();
  setInterval(draw, 20_000);
  window.addEventListener("hashchange", () => setTimeout(draw, 0));
})();
