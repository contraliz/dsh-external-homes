window.__ModuleLoader__.load({
  id: "dsh-external-homes",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const PAGE_SIZE = 300;
    const VISIBLE_PER_GROUP = 5;

    function timeLabel(value) {
      if (typeof value !== "number" && typeof value !== "string") return "Unknown date";
      const date = new Date(value);
      return Number.isNaN(date.valueOf()) ? "Unknown date" : date.toLocaleString();
    }

    function bytesLabel(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function errorMessage(error, fallback) {
      return error instanceof Error && error.message !== "" ? error.message : fallback;
    }

    function workspaceTitle(cwd) {
      if (typeof cwd !== "string" || cwd === "") return "No workspace";
      const trimmed = cwd.replace(/[\\/]+$/, "");
      const parts = trimmed.split(/[\\/]/);
      return parts[parts.length - 1] || cwd;
    }

    function groupSessions(sessions) {
      const groups = [];
      const byCwd = new Map();
      for (const session of sessions) {
        const cwd = typeof session.header.cwd === "string" ? session.header.cwd : "";
        let group = byCwd.get(cwd);
        if (group === undefined) {
          group = { cwd, sessions: [] };
          byCwd.set(cwd, group);
          groups.push(group);
        }
        group.sessions.push(session);
      }
      return groups;
    }

    function detailsLine(parts) {
      return parts.filter(part => typeof part === "string" && part !== "").join(" · ");
    }

    function sourceStatusText(source) {
      if (source.status === "ready") return `${source.count} conversation${source.count === 1 ? "" : "s"}`;
      if (source.status === "missing") return "No sessions folder yet";
      if (source.status === "error") return source.error || "Unavailable";
      if (source.status === "pending") return "Checking…";
      return "Unavailable";
    }

    async function callApi(action, args, signal) {
      const response = await fetch("api/external-homes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, args }),
        ...(signal === undefined ? {} : { signal }),
      });
      const text = await response.text();
      let body;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        throw new Error(`The host returned an unreadable response (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `The host rejected the request (HTTP ${response.status}).`);
      }
      if (!body || body.ok !== true) {
        throw new Error(body?.error?.message || "The host could not complete the request.");
      }
      return body.value;
    }

    const emptyList = { sources: [], sessions: [], total: 0, offset: 0, limit: PAGE_SIZE, registration: { enabled: true } };

    function makePanel(ctx) {
      return function ExternalWorkspacesPanel() {
        const [listRequest, setListRequest] = React.useState({ revision: 0 });
        const [listData, setListData] = React.useState(emptyList);
        const [listBusy, setListBusy] = React.useState(false);
        const [listError, setListError] = React.useState("");
        const [addPath, setAddPath] = React.useState("");
        const [addBusy, setAddBusy] = React.useState(false);
        const [addError, setAddError] = React.useState("");
        const [removingId, setRemovingId] = React.useState("");
        const [removeError, setRemoveError] = React.useState("");
        const [openingKey, setOpeningKey] = React.useState("");
        const [openError, setOpenError] = React.useState("");
        const [expandedGroups, setExpandedGroups] = React.useState({});
        const [collapsedHomes, setCollapsedHomes] = React.useState({});

        React.useEffect(() => {
          const controller = new AbortController();
          let active = true;
          setListBusy(true);
          setListError("");
          callApi("list", { limit: PAGE_SIZE }, controller.signal)
            .then((value) => {
              if (active) setListData(value);
            })
            .catch((error) => {
              if (active) setListError(errorMessage(error, "Could not load the external workspaces."));
            })
            .finally(() => {
              if (active) setListBusy(false);
            });
          return () => {
            active = false;
            controller.abort();
          };
        }, [listRequest]);

        const refresh = () => setListRequest(previous => ({ revision: previous.revision + 1 }));
        const toggleGroup = (key) => setExpandedGroups(previous => ({ ...previous, [key]: previous[key] !== true }));
        const toggleHome = (sourceId) => setCollapsedHomes(previous => ({ ...previous, [sourceId]: previous[sourceId] !== true }));

        const addHome = async (event) => {
          event.preventDefault();
          const path = addPath.trim();
          if (path === "" || addBusy) return;
          setAddBusy(true);
          setAddError("");
          try {
            const value = await callApi("register", { path });
            setAddPath("");
            setListData(previous => ({ ...previous, sources: value.sources, registration: value.registration }));
            setListRequest(previous => ({ revision: previous.revision + 1 }));
          } catch (error) {
            setAddError(errorMessage(error, "Could not register that DSH home."));
          } finally {
            setAddBusy(false);
          }
        };

        const removeHome = async (source) => {
          if (removingId !== "" || openingKey !== "") return;
          const confirmed = typeof window !== "undefined" && typeof window.confirm === "function"
            ? window.confirm(`Remove "${source.label}"? Its session files stay on disk.`)
            : true;
          if (!confirmed) return;
          setRemovingId(source.id);
          setRemoveError("");
          try {
            const value = await callApi("remove", { sourceId: source.id });
            setListData(previous => ({ ...previous, sources: value.sources, registration: value.registration }));
            setListRequest(previous => ({ revision: previous.revision + 1 }));
          } catch (error) {
            setRemoveError(errorMessage(error, "Could not remove that DSH home."));
          } finally {
            setRemovingId("");
          }
        };

        const openConversation = async (source, session) => {
          if (openingKey !== "") return;
          const key = `${source.id}:${session.header.id}`;
          setOpeningKey(key);
          setOpenError("");
          try {
            const value = await callApi("import", { sourceId: source.id, id: session.header.id });
            await ctx.sessions.refresh();
            let opened = false;
            let lastError;
            for (let attempt = 0; attempt < 10 && !opened; attempt += 1) {
              try {
                ctx.uiWorkspace.openSession(value.sessionId);
                opened = true;
              } catch (error) {
                lastError = error;
                if (!(error instanceof Error) || !/unknown session/i.test(error.message)) throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            }
            if (!opened) {
              throw lastError ?? new Error("The imported conversation did not appear in the session list.");
            }
          } catch (error) {
            setOpenError(errorMessage(error, "Could not open this conversation."));
          } finally {
            setOpeningKey("");
          }
        };

        const sessionsBySource = React.useMemo(() => {
          const map = new Map();
          for (const session of listData.sessions) {
            const list = map.get(session.sourceId) ?? [];
            list.push(session);
            map.set(session.sourceId, list);
          }
          return map;
        }, [listData.sessions]);

        const registration = listData.registration || { enabled: true };

        const renderSession = (source, session) => {
          const key = `${source.id}:${session.header.id}`;
          const busy = openingKey === key;
          const title = session.title || workspaceTitle(session.header.cwd) || session.header.id;
          const size = bytesLabel(session.sizeBytes);
          const details = detailsLine([
            timeLabel(session.header.createdAt),
            typeof session.eventCount === "number" ? `${session.eventCount} events` : "",
            size,
          ]);
          return h("button", {
            key,
            type: "button",
            onClick: () => openConversation(source, session),
            disabled: openingKey !== "",
            style: { ...sessionRowStyle, ...(busy ? { opacity: 0.7 } : {}) },
            title: session.header.cwd || session.header.id,
          },
          h("span", { style: { display: "block", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, busy ? "Opening…" : title),
          h("span", { style: { ...mutedStyle, display: "block", textAlign: "left", marginTop: 2 } }, details),
          h("code", { style: { ...mutedStyle, display: "block", textAlign: "left", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, session.header.id));
        };

        const renderGroup = (source, group) => {
          const groupKey = `${source.id}\0${group.cwd}`;
          const isExpanded = expandedGroups[groupKey] === true;
          const visible = isExpanded ? group.sessions : group.sessions.slice(0, VISIBLE_PER_GROUP);
          const remaining = group.sessions.length - visible.length;
          return h("div", { key: groupKey, style: groupStyle },
            h("div", { style: workspaceHeaderStyle },
              h("span", { style: { opacity: 0.8, fontSize: 13 } }, "📁"),
              h("span", { style: { fontWeight: 600, overflowWrap: "anywhere" } }, workspaceTitle(group.cwd)),
              h("span", { style: mutedStyle }, `${group.sessions.length}`)),
            group.cwd === "" ? null : h("div", { style: { ...mutedStyle, marginLeft: 18, marginBottom: 4, overflowWrap: "anywhere" } }, group.cwd),
            h("div", { style: sessionListStyle }, visible.map(session => renderSession(source, session))),
            remaining > 0
              ? h("button", { type: "button", onClick: () => toggleGroup(groupKey), style: showMoreStyle }, `Show ${remaining} more`)
              : null,
            isExpanded && group.sessions.length > VISIBLE_PER_GROUP
              ? h("button", { type: "button", onClick: () => toggleGroup(groupKey), style: showMoreStyle }, "Show less")
              : null);
        };

        const renderSource = (source) => {
          const collapsed = collapsedHomes[source.id] === true;
          const sourceSessions = sessionsBySource.get(source.id) ?? [];
          const groups = groupSessions(sourceSessions);
          return h("section", { key: source.id, style: homeSectionStyle },
            h("div", { style: homeHeaderStyle },
              h("button", {
                type: "button",
                onClick: () => toggleHome(source.id),
                style: homeToggleStyle,
                "aria-expanded": !collapsed,
              },
              h("span", { style: { width: 12, opacity: 0.7 } }, collapsed ? "▸" : "▾"),
              h("span", { style: { fontWeight: 600, overflowWrap: "anywhere" } }, source.label)),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", flex: "none" } },
                h("span", { style: badgeStyle }, source.origin === "config" ? "Configured" : "Registered"),
                source.origin === "registry" && registration.enabled
                  ? h("button", {
                    type: "button",
                    onClick: () => removeHome(source),
                    disabled: removingId !== "" || openingKey !== "",
                    style: smallButtonStyle,
                  }, removingId === source.id ? "Removing…" : "Remove")
                  : null)),
            h("div", { style: { ...mutedStyle, margin: "2px 0 4px 18px", overflowWrap: "anywhere" } }, source.path),
            h("div", { style: { ...mutedStyle, marginLeft: 18, marginBottom: 6 } }, sourceStatusText(source)),
            collapsed
              ? null
              : groups.length === 0
                ? h("p", { style: { ...mutedStyle, marginLeft: 18 } }, source.status === "missing" ? "No sessions folder yet." : "No conversations.")
                : h("div", { style: { marginLeft: 18 } }, groups.map(group => renderGroup(source, group))));
        };

        const end = Math.min(listData.offset + listData.sessions.length, listData.total);

        return h("section", { style: panelStyle },
          h("div", { style: toolbarStyle },
            h("div", null,
              h("h2", { style: titleStyle }, "External workspaces"),
              h("div", { style: mutedStyle }, "Sessions from other DSH homes. Opening one shows it in the normal DSH conversation view.")),
            h("button", { type: "button", onClick: refresh, style: buttonStyle, disabled: listBusy }, listBusy ? "Refreshing…" : "Refresh")),

          registration.enabled
            ? h("form", { onSubmit: addHome, style: addFormStyle },
              h("input", {
                type: "text",
                value: addPath,
                onChange: event => setAddPath(event.target.value),
                placeholder: "D:\\work\\other-dsh-home",
                spellCheck: false,
                autoComplete: "off",
                "aria-label": "DSH home folder path",
                style: inputStyle,
                disabled: addBusy,
              }),
              h("button", { type: "submit", style: buttonStyle, disabled: addBusy || addPath.trim() === "" }, addBusy ? "Adding…" : "Add DSH home"),
              h("div", { style: { ...mutedStyle, flexBasis: "100%" } }, "Choose the folder that contains a sessions directory, usually the DSH home itself."))
            : h("p", { style: mutedStyle }, "Runtime registration is disabled in this profile configuration."),

          registration.error ? h("p", { role: "alert", style: warningStyle }, registration.error) : null,
          addError ? h("p", { role: "alert", style: errorStyle }, addError) : null,
          removeError ? h("p", { role: "alert", style: errorStyle }, removeError) : null,
          listError ? h("p", { role: "alert", style: errorStyle }, listError) : null,
          openError ? h("p", { role: "alert", style: errorStyle }, openError) : null,

          listData.sources.length === 0 && !listBusy
            ? h("p", { style: mutedStyle }, "No DSH homes are registered yet. Add one above, or set homes in the profile patch.")
            : h("div", null, listData.sources.map(renderSource)),

          listData.total > listData.sessions.length
            ? h("p", { style: mutedStyle }, `Showing the ${listData.sessions.length} most recent of ${listData.total} conversations.`)
            : null,

          listData.total === 0 ? null : h("div", { style: { ...mutedStyle, marginTop: 12 } }, `${listData.offset + 1}–${end} of ${listData.total}`));
      };
    }

    function PanelIcon({ size = 16, active = false }) {
      return h("svg", {
        "aria-hidden": "true",
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: active ? 1.6 : 1.3,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        style: { display: "block", flex: "none" },
      },
      h("path", { d: "M2.75 7.25 8 3l5.25 4.25" }),
      h("path", { d: "M4.25 6.5V13h7.5V6.5" }),
      h("path", { d: "M6.5 13V9.75h3V13" }));
    }

    const panelStyle = { height: "100%", minHeight: 0, overflow: "auto", padding: 20, color: "inherit", boxSizing: "border-box" };
    const toolbarStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 };
    const titleStyle = { fontSize: 18, margin: 0 };
    const buttonStyle = { color: "inherit", background: "transparent", border: "1px solid rgba(127,127,127,.35)", borderRadius: 6, padding: "7px 11px", cursor: "pointer" };
    const smallButtonStyle = { ...buttonStyle, padding: "4px 8px", fontSize: 12 };
    const mutedStyle = { opacity: 0.72, fontSize: 12 };
    const errorStyle = { color: "var(--dsw-color-danger, #b42318)", padding: 10, border: "1px solid currentColor", borderRadius: 6 };
    const warningStyle = { color: "var(--dsw-color-warning, #9a6700)", padding: 10, border: "1px solid currentColor", borderRadius: 6 };
    const addFormStyle = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "14px 0 18px" };
    const inputStyle = { color: "inherit", background: "transparent", border: "1px solid rgba(127,127,127,.35)", borderRadius: 6, padding: "7px 10px", flex: "1 1 320px", minWidth: 0, font: "inherit", boxSizing: "border-box" };
    const homeSectionStyle = { marginBottom: 18, paddingBottom: 12, borderBottom: "1px solid rgba(127,127,127,.18)" };
    const homeHeaderStyle = { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" };
    const homeToggleStyle = { color: "inherit", background: "transparent", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, font: "inherit", minWidth: 0, textAlign: "left" };
    const badgeStyle = { border: "1px solid rgba(127,127,127,.3)", borderRadius: 999, padding: "1px 7px", fontSize: 11, whiteSpace: "nowrap" };
    const groupStyle = { margin: "8px 0 10px" };
    const workspaceHeaderStyle = { display: "flex", alignItems: "center", gap: 6, marginBottom: 2 };
    const sessionListStyle = { display: "grid", gap: 2, marginLeft: 18 };
    const sessionRowStyle = { color: "inherit", background: "transparent", border: "none", borderRadius: 6, padding: "6px 8px", cursor: "pointer", textAlign: "left", minWidth: 0, font: "inherit" };
    const showMoreStyle = { color: "inherit", opacity: 0.72, background: "transparent", border: "none", padding: "4px 8px", marginLeft: 18, cursor: "pointer", fontSize: 12, textAlign: "left" };

    function apply(ctx) {
      const Panel = makePanel(ctx);

      ctx.slots.inject("sidebar.panellist", function* () {
        yield ctx.slots.register({
          name: "sidebar.panellist",
          id: "external-workspaces",
          order: 40,
          label: "External workspaces",
        }, PanelIcon);
      });

      ctx.slots.inject("main", function* () {
        yield ctx.slots.register({
          name: "main",
          key: "external-workspaces",
        }, Panel);
      });
    }

    exports.inject = ["slots", "sessions", "uiWorkspace"];
    exports.apply = apply;
    return module.exports;
  },
});
