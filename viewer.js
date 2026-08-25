(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const elements = {
    loading: $("#viewerLoading"), auth: $("#authScreen"), authForm: $("#authForm"), authEmail: $("#authEmail"),
    authPassword: $("#authPassword"), authSubmit: $("#authSubmit"), authStatus: $("#authStatus"),
    shell: $("#viewerShell"), projectSelect: $("#projectSelect"), projectList: $("#projectList"), projectCount: $("#projectCount"),
    publishedAt: $("#publishedAt"), refresh: $("#refreshViewer"), signOut: $("#signOutViewer"), tabs: [...document.querySelectorAll("[data-view]")],
    boardView: $("#boardView"), navView: $("#navView"), notesView: $("#notesView"), boardTitle: $("#boardTitle"),
    boardViewport: $("#boardViewport"), boardStage: $("#boardStage"), fitBoard: $("#fitBoard"), navTree: $("#navTree"), expandNav: $("#expandNav"),
    noteSearch: $("#noteSearch"), noteList: $("#noteList"), toggleNoteSources: $("#toggleNoteSources"), readerPanel: $("#readerPanel"), readerHeading: $("#readerHeading"),
    readerContent: $("#readerContent"), readerBack: $("#readerBack"), readerCopy: $("#readerCopy"), message: $("#viewerMessage"),
  };
  const config = window.BLUE_BROWN_VIEWER_CONFIG || {};
  const hasCloudConfig = /^https:\/\//.test(config.supabaseUrl || "") && Boolean(config.publishableKey);
  const state = {
    snapshot: null,
    projectId: "",
    view: "board",
    selectedEndpoint: "",
    transform: {x: 0, y: 0, zoom: 1},
    pointers: new Map(),
    gesture: null,
    expandedNav: new Set(),
    allNavExpanded: true,
    collapsedNoteSources: new Set(),
    readerCopyText: "",
    client: null,
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"}[character]));
  }

  function inlineMarkdown(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  }

  function markdown(value) {
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    let paragraph = [];
    let list = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list.length) return;
      output.push(`<ul>${list.map(item => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      list = [];
    };
    lines.forEach(line => {
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (heading) {
        flushParagraph(); flushList();
        const level = heading[1].length;
        output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      } else if (bullet) {
        flushParagraph(); list.push(bullet[1]);
      } else if (!line.trim()) {
        flushParagraph(); flushList();
      } else {
        flushList(); paragraph.push(line);
      }
    });
    flushParagraph(); flushList();
    return output.join("");
  }

  function textParts(value) {
    const lines = String(value || "").trim().split(/\r?\n/);
    const first = lines.findIndex(line => line.trim());
    if (first < 0) return {title: "새 글", body: ""};
    return {title: lines[first].trim(), body: lines.slice(first + 1).join("\n").trim()};
  }

  function currentProject() {
    return state.snapshot?.projects?.find(project => project.id === state.projectId) || null;
  }

  function noteById(noteId) {
    return state.snapshot?.notes?.find(note => note.id === noteId) || null;
  }

  function endpointItem(project, endpoint) {
    const node = project?.nodes?.find(item => item.id === endpoint);
    if (node) return {kind: "note", data: node};
    const group = project?.groups?.find(item => item.id === endpoint);
    if (group) return {kind: group.type === "text" ? "text" : "heading", data: group};
    return null;
  }

  function noteDisplay(project, noteId) {
    const note = noteById(noteId);
    const member = project?.members?.[noteId] || {};
    return {
      title: note?.title || member.lead || "삭제된 메모",
      body: note?.body || member.summary || "원본 메모를 찾지 못했습니다.",
      paperTitle: note?.paperTitle || member.sourceTitle || "출처 정보 없음",
      paperAuthor: note?.paperAuthor || member.sourceAuthor || "",
      note,
    };
  }

  function showMessage(message, timeout = 2800) {
    elements.message.textContent = message;
    elements.message.classList.remove("hidden");
    window.clearTimeout(showMessage.timer);
    showMessage.timer = window.setTimeout(() => elements.message.classList.add("hidden"), timeout);
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard API unavailable");
  }

  function setLoading(done) {
    elements.loading.classList.toggle("done", Boolean(done));
  }

  function setView(view) {
    state.view = ["board", "nav", "notes"].includes(view) ? view : "board";
    elements.tabs.forEach(button => button.classList.toggle("active", button.dataset.view === state.view));
    elements.boardView.classList.toggle("hidden", state.view !== "board");
    elements.navView.classList.toggle("hidden", state.view !== "nav");
    elements.notesView.classList.toggle("hidden", state.view !== "notes");
    if (state.view === "board") window.requestAnimationFrame(() => fitBoard(false));
    if (state.view === "nav") renderNav();
    if (state.view === "notes") renderNotes();
  }

  function projectNoteIds(project) {
    return new Set((project?.nodes || []).map(node => node.noteId).filter(Boolean));
  }

  function renderProjects() {
    const projects = state.snapshot?.projects || [];
    if (!projects.some(project => project.id === state.projectId)) state.projectId = projects[0]?.id || "";
    elements.projectCount.textContent = `${projects.length}`;
    elements.projectSelect.innerHTML = projects.map(project => `<option value="${escapeHtml(project.id)}" ${project.id === state.projectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
    elements.projectList.innerHTML = projects.map(project => `<button class="project-item ${project.id === state.projectId ? "active" : ""}" type="button" data-project="${escapeHtml(project.id)}" style="--project-color:${escapeHtml(project.defaultColor)}"><span>${escapeHtml(project.name)}</span></button>`).join("");
  }

  function rectangleBoundary(item, toward, clearance = 2) {
    const dx = toward.x - item.x;
    const dy = toward.y - item.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    const ux = dx / length;
    const uy = dy / length;
    const halfWidth = Math.max(8, Number(item.width) || 180) / 2;
    const halfHeight = Math.max(8, Number(item.height) || 80) / 2;
    const scale = Math.min(halfWidth / Math.max(0.001, Math.abs(ux)), halfHeight / Math.max(0.001, Math.abs(uy)));
    return {x: item.x + ux * (scale + clearance), y: item.y + uy * (scale + clearance)};
  }

  function relationGeometry(from, to, edge) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const direction = [...String(edge.id || "")].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 2 ? 1 : -1;
    const hasBend = edge.bend !== null && edge.bend !== undefined && Number.isFinite(Number(edge.bend));
    const bendRatio = hasBend ? Number(edge.bend) : 0.16 * direction;
    const alongRatio = Number.isFinite(Number(edge.along)) ? Number(edge.along) : 0;
    const control = {
      x: (from.x + to.x) / 2 + (dx / distance) * alongRatio * distance + (-dy / distance) * bendRatio * distance,
      y: (from.y + to.y) / 2 + (dy / distance) * alongRatio * distance + (dx / distance) * bendRatio * distance,
    };
    const mode = ["forward", "backward", "both"].includes(edge.arrowMode) ? edge.arrowMode : "none";
    const arrowLength = Math.max(9, Math.min(13, distance * 0.04));
    const start = rectangleBoundary(from, control, mode === "backward" || mode === "both" ? arrowLength * 0.9 : 2);
    const end = rectangleBoundary(to, control, mode === "forward" || mode === "both" ? arrowLength * 0.9 : 2);
    const arrow = (tip, tangent, reverse = false) => {
      const length = Math.max(0.001, Math.hypot(tangent.x, tangent.y));
      const ux = tangent.x / length * (reverse ? -1 : 1);
      const uy = tangent.y / length * (reverse ? -1 : 1);
      const nx = -uy, ny = ux, wing = arrowLength * 0.48;
      const bx = tip.x - ux * arrowLength, by = tip.y - uy * arrowLength;
      return `M ${bx + nx * wing} ${by + ny * wing} L ${tip.x} ${tip.y} L ${bx - nx * wing} ${by - ny * wing}`;
    };
    return {
      path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
      forward: mode === "forward" || mode === "both" ? arrow(end, {x: to.x - control.x, y: to.y - control.y}) : "",
      backward: mode === "backward" || mode === "both" ? arrow(start, {x: control.x - from.x, y: control.y - from.y}, true) : "",
      labelX: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
      labelY: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
    };
  }

  function boxHtml(project, item) {
    const data = item.data;
    const style = `left:${data.x}px;top:${data.y}px;width:${data.width}px;height:${data.height}px;--box-color:${escapeHtml(data.color || project.defaultColor)}`;
    const bookmark = data.bookmarked ? `<span class="box-bookmark">★</span>` : "";
    const compact = data.compact ? " compact" : "";
    if (item.kind === "heading") {
      const level = Math.max(1, Math.min(4, Number(data.headingLevel) || 2));
      return `<article class="board-box heading level-${level}" data-endpoint="${escapeHtml(data.id)}" style="${style}">${bookmark}<button type="button">${inlineMarkdown(data.title)}</button></article>`;
    }
    if (item.kind === "text") {
      const parts = textParts(data.body || data.title);
      return `<article class="board-box text${compact}" data-endpoint="${escapeHtml(data.id)}" style="${style}">${bookmark}<button type="button"><span class="box-title">${inlineMarkdown(parts.title)}</span>${parts.body ? `<span class="box-summary">${inlineMarkdown(parts.body)}</span>` : ""}</button></article>`;
    }
    const display = noteDisplay(project, data.noteId);
    const body = textParts(display.body).body;
    return `<article class="board-box note${compact}" data-endpoint="${escapeHtml(data.id)}" style="${style}">${bookmark}<button type="button"><span class="box-title">${inlineMarkdown(display.title)}</span><span class="box-source">${escapeHtml(display.paperTitle)}</span>${display.paperAuthor ? `<span class="box-author">${escapeHtml(display.paperAuthor)}</span>` : ""}${body ? `<span class="box-summary">${inlineMarkdown(body)}</span>` : ""}</button></article>`;
  }

  function renderBoard() {
    const project = currentProject();
    if (!project) {
      elements.boardStage.innerHTML = "";
      elements.boardTitle.textContent = "프로젝트가 없습니다.";
      return;
    }
    elements.boardTitle.textContent = project.name;
    const endpoints = new Map([...project.nodes, ...project.groups].map(item => [item.id, item]));
    const edges = project.edges.map(edge => {
      const from = endpoints.get(edge.from), to = endpoints.get(edge.to);
      if (!from || !to) return "";
      if (edge.kind === "hierarchy") return `<line class="edge-hierarchy" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"></line>`;
      const geometry = relationGeometry(from, to, edge);
      const color = escapeHtml(edge.color || "#8a5962");
      const fontSize = Math.max(9, Math.min(24, Math.round(Number(edge.fontSize) || 12)));
      const label = String(edge.label || "").split(/\r?\n/).filter(Boolean);
      const text = label.length ? `<text class="edge-label" text-anchor="middle" x="${geometry.labelX}" y="${geometry.labelY - fontSize * 0.72}">${label.map((line, index) => `<tspan x="${geometry.labelX}" dy="${index ? fontSize * 1.22 : 0}">${escapeHtml(line)}</tspan>`).join("")}</text>` : "";
      const arrowLayers = path => path ? `<path class="edge-arrow edge-arrow-halo" d="${path}"></path><path class="edge-arrow edge-arrow-core" d="${path}"></path>` : "";
      return `<g class="edge-relation-group" style="--edge-color:${color};--edge-font-size:${fontSize}px"><path class="edge-relation relation-halo" d="${geometry.path}"></path><path class="edge-relation relation-core" d="${geometry.path}"></path>${arrowLayers(geometry.forward)}${arrowLayers(geometry.backward)}${text}</g>`;
    }).join("");
    const boxes = [...project.groups.map(data => ({kind: data.type === "text" ? "text" : "heading", data})), ...project.nodes.map(data => ({kind: "note", data}))].map(item => boxHtml(project, item)).join("");
    elements.boardStage.innerHTML = `<svg class="edge-layer" viewBox="0 0 2400 1600" aria-hidden="true">${edges}</svg>${boxes}`;
    if (state.selectedEndpoint) elements.boardStage.querySelector(`[data-endpoint="${CSS.escape(state.selectedEndpoint)}"]`)?.classList.add("selected");
    applyTransform();
  }

  function applyTransform() {
    elements.boardStage.style.transform = `translate(${state.transform.x}px, ${state.transform.y}px) scale(${state.transform.zoom})`;
  }

  function fitBoard(animate = true) {
    const project = currentProject();
    const items = project ? [...project.nodes, ...project.groups] : [];
    if (!items.length || !elements.boardViewport.clientWidth) return;
    const minX = Math.min(...items.map(item => item.x - item.width / 2)) - 90;
    const maxX = Math.max(...items.map(item => item.x + item.width / 2)) + 90;
    const minY = Math.min(...items.map(item => item.y - item.height / 2)) - 90;
    const maxY = Math.max(...items.map(item => item.y + item.height / 2)) + 90;
    const zoom = Math.max(0.28, Math.min(1.35, Math.min(elements.boardViewport.clientWidth / Math.max(1, maxX - minX), elements.boardViewport.clientHeight / Math.max(1, maxY - minY))));
    state.transform = {x: (elements.boardViewport.clientWidth - (minX + maxX) * zoom) / 2, y: (elements.boardViewport.clientHeight - (minY + maxY) * zoom) / 2, zoom};
    elements.boardStage.style.transition = animate ? "transform 280ms ease" : "none";
    applyTransform();
    window.setTimeout(() => { elements.boardStage.style.transition = ""; }, 300);
  }

  function hierarchyChildren(project, endpoint) {
    const ids = project.edges.filter(edge => edge.kind === "hierarchy" && edge.from === endpoint).map(edge => edge.to);
    return ids.map(id => endpointItem(project, id)).filter(Boolean).sort((a, b) =>
      (Number(a.data.order) || 0) - (Number(b.data.order) || 0)
      || (Number(a.data.y) || 0) - (Number(b.data.y) || 0)
      || (Number(a.data.x) || 0) - (Number(b.data.x) || 0)
      || String(a.data.id).localeCompare(String(b.data.id))
    );
  }

  function hierarchyRoots(project) {
    const incoming = new Set(project.edges.filter(edge => edge.kind === "hierarchy").map(edge => edge.to));
    return [...project.groups.map(data => ({kind: data.type === "text" ? "text" : "heading", data})), ...project.nodes.map(data => ({kind: "note", data}))]
      .filter(item => !incoming.has(item.data.id))
      .sort((a, b) => (Number(a.data.order) || 0) - (Number(b.data.order) || 0));
  }

  function romanNumeral(value) {
    const numerals = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let remaining = Math.max(1, Math.floor(Number(value) || 1));
    let result = "";
    numerals.forEach(([amount, numeral]) => {
      while (remaining >= amount) {
        result += numeral;
        remaining -= amount;
      }
    });
    return result;
  }

  function outlineRows(project) {
    const rows = [];
    const visited = new Set();
    const items = [...project.groups.map(data => ({id: data.id, kind: data.type === "text" ? "text" : "heading", data})), ...project.nodes.map(data => ({id: data.id, kind: "note", data}))];
    const byId = new Map(items.map(item => [item.id, item]));
    const adjacency = new Map(items.map(item => [item.id, []]));
    const incoming = new Map(items.map(item => [item.id, 0]));
    project.edges.filter(edge => edge.kind === "hierarchy").forEach(edge => {
      if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) return;
      adjacency.get(edge.from).push(edge.to);
      incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    });
    const sortIds = ids => [...ids].sort((leftId, rightId) => {
      const left = byId.get(leftId), right = byId.get(rightId);
      return (Number(left?.data.order) || 0) - (Number(right?.data.order) || 0)
        || (Number(left?.data.y) || 0) - (Number(right?.data.y) || 0)
        || (Number(left?.data.x) || 0) - (Number(right?.data.x) || 0)
        || String(leftId).localeCompare(String(rightId));
    });
    const walkBranch = (endpoint, treeDepth, contentDepth, unassigned) => {
      sortIds(adjacency.get(endpoint) || []).forEach(neighborId => {
        if (visited.has(neighborId)) return;
        const neighbor = byId.get(neighborId);
        if (!neighbor) return;
        const nextContentDepth = neighbor.kind === "heading" ? 0 : (byId.get(endpoint)?.kind === "heading" ? 0 : contentDepth + 1);
        visited.add(neighborId);
        rows.push({item: neighbor, depth: treeDepth + 1, contentDepth: nextContentDepth, parentId: endpoint, unassigned});
        walkBranch(neighborId, treeDepth + 1, nextContentDepth, unassigned);
      });
    };
    const rootSort = (a, b) => (a.kind === "heading" ? 0 : 1) - (b.kind === "heading" ? 0 : 1)
      || (Number(a.data.headingLevel) || 2) - (Number(b.data.headingLevel) || 2)
      || (Number(a.data.y) || 0) - (Number(b.data.y) || 0)
      || (Number(a.data.x) || 0) - (Number(b.data.x) || 0);
    const addRoot = (item, unassigned) => {
      if (!item || visited.has(item.id)) return;
      visited.add(item.id);
      rows.push({item, depth: 0, contentDepth: 0, parentId: "", unassigned});
      walkBranch(item.id, 0, 0, unassigned);
    };
    items.filter(item => item.kind === "heading" && (Number(item.data.headingLevel) === 1 || !(incoming.get(item.id) || 0))).sort(rootSort).forEach(item => addRoot(item, false));
    items.filter(item => !(incoming.get(item.id) || 0)).sort(rootSort).forEach(item => addRoot(item, item.kind !== "heading"));
    items.filter(item => item.kind === "heading").sort(rootSort).forEach(item => addRoot(item, false));
    items.filter(item => !visited.has(item.id)).sort(rootSort).forEach(item => addRoot(item, true));
    return rows;
  }

  function outlineNumbering(rows) {
    const counters = new Map();
    const numbering = new Map();
    rows.forEach(row => {
      const parentNumbering = row.parentId ? numbering.get(row.parentId) : null;
      let tier = null;
      let counterKey = "";
      if (parentNumbering?.inBranch) {
        tier = parentNumbering.tier + 1;
        counterKey = `children:${row.parentId}:${tier}`;
      } else if (row.item.kind === "heading") {
        tier = Math.max(0, Math.min(3, (Number(row.item.data.headingLevel) || 2) - 1));
        counterKey = `roots:${row.parentId || "project"}:${tier}`;
      }
      if (tier === null) {
        numbering.set(row.item.id, {inBranch: false, tier: null, label: ""});
        return;
      }
      let label = "";
      if (tier <= 2) {
        const index = (counters.get(counterKey) || 0) + 1;
        counters.set(counterKey, index);
        label = tier === 0 ? `${romanNumeral(index)}.` : tier === 1 ? `${index}.` : `${index})`;
      }
      numbering.set(row.item.id, {inBranch: true, tier, label});
    });
    return numbering;
  }

  function itemTitle(project, item) {
    if (item.kind === "note") return noteDisplay(project, item.data.noteId).title;
    return item.kind === "text" ? textParts(item.data.body || item.data.title).title : item.data.title;
  }

  function navRows(project, item, depth, visited) {
    if (visited.has(item.data.id)) return "";
    visited.add(item.data.id);
    const children = hierarchyChildren(project, item.data.id);
    const expanded = state.allNavExpanded || state.expandedNav.has(item.data.id);
    const display = item.kind === "note" ? noteDisplay(project, item.data.noteId) : null;
    const source = display ? `${display.paperTitle}${display.paperAuthor ? ` · ${display.paperAuthor}` : ""}` : "";
    return `<div class="nav-row ${item.kind}" style="--depth:${Math.min(depth, 6)}"><div class="nav-row-main">${children.length ? `<button class="nav-toggle" type="button" data-nav-toggle="${escapeHtml(item.data.id)}">${expanded ? "▾" : "▸"}</button>` : `<span class="nav-toggle"></span>`}<div class="nav-label"><button class="nav-open" type="button" data-endpoint="${escapeHtml(item.data.id)}">${escapeHtml(itemTitle(project, item))}</button>${source ? `<span class="nav-source">${escapeHtml(source)}</span>` : ""}</div></div>${expanded ? children.map(child => navRows(project, child, depth + 1, visited)).join("") : ""}</div>`;
  }

  function renderNav() {
    const project = currentProject();
    if (!project) { elements.navTree.innerHTML = ""; return; }
    elements.expandNav.textContent = state.allNavExpanded ? "모두 접기" : "모두 펴기";
    elements.navTree.innerHTML = hierarchyRoots(project).map(item => navRows(project, item, 0, new Set())).join("") || `<div class="reader-empty">표시할 네비 구조가 없습니다.</div>`;
  }

  function projectNotes(project) {
    const ids = projectNoteIds(project);
    return (state.snapshot?.notes || []).filter(note => ids.has(note.id)).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  }

  function noteSourceKey(note) {
    return note.sourceId ? `id:${note.sourceId}` : `meta:${note.paperTitle || "출처 정보 없음"}\u241f${note.paperAuthor || ""}`;
  }

  function noteSourceStateKey(project, sourceKey) {
    return `${project.id}\u241e${sourceKey}`;
  }

  function noteSourceGroups(notes) {
    const groups = new Map();
    notes.forEach(note => {
      const key = noteSourceKey(note);
      if (!groups.has(key)) groups.set(key, {
        key,
        title: note.paperTitle || "출처 정보 없음",
        author: note.paperAuthor || "",
        notes: [],
      });
      groups.get(key).notes.push(note);
    });
    return [...groups.values()];
  }

  function renderNotes() {
    const project = currentProject();
    if (!project) { elements.noteList.innerHTML = ""; return; }
    const query = elements.noteSearch.value.trim().toLocaleLowerCase();
    const notes = projectNotes(project).filter(note => !query || [note.title, note.body, note.paperTitle, note.paperAuthor].join(" ").toLocaleLowerCase().includes(query));
    const groups = noteSourceGroups(notes);
    const collapsedCount = groups.filter(group => state.collapsedNoteSources.has(noteSourceStateKey(project, group.key))).length;
    elements.toggleNoteSources.textContent = groups.length > 0 && collapsedCount === groups.length ? "모두 펴기" : "모두 접기";
    elements.toggleNoteSources.disabled = groups.length === 0;
    elements.noteList.innerHTML = groups.map(group => {
      const stateKey = noteSourceStateKey(project, group.key);
      const collapsed = state.collapsedNoteSources.has(stateKey);
      const items = collapsed ? "" : group.notes.map(note => `<button class="note-list-item" type="button" data-note-id="${escapeHtml(note.id)}"><strong>${escapeHtml(note.title)}</strong><p>${escapeHtml(textParts(note.body).body || note.body)}</p></button>`).join("");
      return `<section class="note-source-group ${collapsed ? "collapsed" : ""}"><button class="note-source-heading" type="button" data-note-source-toggle="${escapeHtml(group.key)}" aria-expanded="${collapsed ? "false" : "true"}"><span class="note-source-chevron">${collapsed ? "▸" : "▾"}</span><span class="note-source-label"><strong>${escapeHtml(group.title)}</strong>${group.author ? `<small>${escapeHtml(group.author)}</small>` : ""}</span><span class="note-source-count">${group.notes.length}</span></button><div class="note-source-items">${items}</div></section>`;
    }).join("") || `<div class="reader-empty">표시할 메모가 없습니다.</div>`;
  }

  function openReader(title, html, copyValue = "") {
    elements.readerHeading.textContent = title;
    elements.readerContent.innerHTML = html;
    elements.readerContent.scrollTop = 0;
    state.readerCopyText = String(copyValue || "").trim();
    elements.readerCopy.classList.toggle("hidden", !state.readerCopyText);
    elements.readerPanel.classList.add("open");
  }

  function openNote(noteId) {
    const project = currentProject();
    const display = noteDisplay(project, noteId);
    const source = [display.paperTitle, display.paperAuthor].filter(Boolean).join(" · ");
    const body = textParts(display.body).body || display.body;
    const copyValue = [`# ${display.title}`, source ? `> 출처: ${source}` : "", body].filter(Boolean).join("\n\n");
    openReader("메모", `<h1 class="reader-title">${escapeHtml(display.title)}</h1><p class="reader-source">${escapeHtml(display.paperTitle)}${display.paperAuthor ? ` · ${escapeHtml(display.paperAuthor)}` : ""}</p><div class="markdown">${markdown(body)}</div>`, copyValue);
  }

  function branchRows(project, rootId) {
    const included = new Set([rootId]);
    const pending = [rootId];
    while (pending.length) {
      const parentId = pending.shift();
      project.edges.filter(edge => edge.kind === "hierarchy" && edge.from === parentId).forEach(edge => {
        if (included.has(edge.to)) return;
        included.add(edge.to);
        pending.push(edge.to);
      });
    }
    return outlineRows(project).filter(row => included.has(row.item.id));
  }

  function branchHtml(project, rows) {
    const numbering = outlineNumbering(outlineRows(project));
    const rootContentDepth = rows[0]?.item.kind === "heading" ? 0 : Math.max(0, Number(rows[0]?.contentDepth) || 0);
    const html = rows.flatMap(row => {
      const item = row.item;
      const number = numbering.get(item.id)?.label || "";
      const numberHtml = className => number ? `<span class="${className}">${escapeHtml(number)}</span>` : "";
      if (item.kind === "heading") {
        const level = Math.max(2, Math.min(6, (Number(item.data.headingLevel) || 2) + 1));
        const title = String(item.data.title || "새 제목").replace(/\s+/g, " ").trim();
        return `<h${level} class="branch-heading ${number ? "numbered" : ""}">${numberHtml("branch-heading-number")}<span class="branch-heading-text">${escapeHtml(title)}</span></h${level}>`;
      }
      const depth = Math.max(0, Math.min(3, (Number(row.contentDepth) || 0) - rootContentDepth));
      const continuation = value => String(value || "").split("\n").filter(line => line.trim()).map(line => `<p class="branch-continuation" style="--depth:${depth}">${inlineMarkdown(line)}</p>`);
      if (item.kind === "text") {
        const parts = textParts(item.data.body || item.data.title);
        return [`<div class="branch-list-item ${number ? "numbered" : ""}" style="--depth:${depth}">${numberHtml("branch-outline-number")}<strong>${escapeHtml(parts.title)}</strong></div>`, ...continuation(parts.body)];
      }
      const display = noteDisplay(project, item.data.noteId);
      const body = textParts(display.body).body || display.body;
      const source = [display.paperTitle, display.paperAuthor].filter(Boolean).join(" · ");
      return [`<div class="branch-list-item ${number ? "numbered" : ""}" style="--depth:${depth}">${numberHtml("branch-outline-number")}<button type="button" data-note-id="${escapeHtml(item.data.noteId)}"><strong>${escapeHtml(display.title)}</strong></button></div>`, ...continuation(body), ...(source ? [`<blockquote class="branch-source" style="--depth:${depth}">출처: ${escapeHtml(source)}</blockquote>`] : [])];
    }).join("");
    return `<div class="branch-preview">${html}</div>`;
  }

  function branchMarkdown(project, rows) {
    const numbering = outlineNumbering(outlineRows(project));
    return rows.flatMap(row => {
      const item = row.item;
      const number = numbering.get(item.id)?.label || "";
      const prefix = number ? `${number} ` : "";
      if (item.kind === "heading") {
        const level = Math.max(1, Math.min(6, Number(item.data.headingLevel) || 2));
        const title = String(item.data.title || "새 제목").replace(/\s+/g, " ").trim();
        return `${"#".repeat(level)} ${prefix}${title}`;
      }
      if (item.kind === "text") {
        const parts = textParts(item.data.body || item.data.title);
        return [`**${prefix}${parts.title}**`, parts.body].filter(Boolean).join("\n\n");
      }
      const display = noteDisplay(project, item.data.noteId);
      const body = textParts(display.body).body || display.body;
      const source = [display.paperTitle, display.paperAuthor].filter(Boolean).join(" · ");
      return [`**${prefix}${display.title}**`, body, source ? `> 출처: ${source}` : ""].filter(Boolean).join("\n\n");
    }).join("\n\n");
  }

  function openEndpoint(endpoint) {
    const project = currentProject();
    const item = endpointItem(project, endpoint);
    if (!item) return;
    state.selectedEndpoint = endpoint;
    elements.boardStage.querySelectorAll(".selected").forEach(element => element.classList.remove("selected"));
    elements.boardStage.querySelector(`[data-endpoint="${CSS.escape(endpoint)}"]`)?.classList.add("selected");
    if (item.kind === "note") openNote(item.data.noteId);
    else if (item.kind === "text") {
      const parts = textParts(item.data.body || item.data.title);
      const number = outlineNumbering(outlineRows(project)).get(item.data.id)?.label || "";
      const copyValue = [`# ${number ? `${number} ` : ""}${parts.title}`, parts.body].filter(Boolean).join("\n\n");
      openReader("글", `<h1 class="reader-title ${number ? "numbered" : ""}">${number ? `<span class="branch-number">${escapeHtml(number)}</span>` : ""}<span>${inlineMarkdown(parts.title)}</span></h1><div class="markdown">${markdown(parts.body)}</div>`, copyValue);
    } else {
      const rows = branchRows(project, item.data.id);
      openReader("하위 글", branchHtml(project, rows), branchMarkdown(project, rows));
    }
  }

  function selectProject(projectId, fit = true) {
    if (!state.snapshot?.projects?.some(project => project.id === projectId)) return;
    state.projectId = projectId;
    state.selectedEndpoint = "";
    elements.readerPanel.classList.remove("open");
    state.readerCopyText = "";
    elements.readerCopy.classList.add("hidden");
    renderProjects(); renderBoard(); renderNav(); renderNotes();
    if (fit) window.requestAnimationFrame(() => fitBoard(false));
    try { localStorage.setItem("blue-brown-viewer-project", projectId); } catch (_error) {}
  }

  function renderSnapshot() {
    const savedProject = (() => { try { return localStorage.getItem("blue-brown-viewer-project") || ""; } catch (_error) { return ""; } })();
    if (!state.snapshot.projects.some(project => project.id === state.projectId)) state.projectId = state.snapshot.projects.some(project => project.id === savedProject) ? savedProject : state.snapshot.projects[0]?.id || "";
    elements.publishedAt.textContent = state.snapshot.publishedAt ? `게시 ${new Date(state.snapshot.publishedAt).toLocaleString("ko-KR")}` : "";
    renderProjects(); renderBoard(); renderNav(); renderNotes(); setView(state.view);
    window.requestAnimationFrame(() => fitBoard(false));
  }

  async function loadSnapshot() {
    let snapshot = null;
    try {
      if (hasCloudConfig) {
        const {data, error} = await state.client.from("library_viewer_snapshots").select("payload,published_at").eq("slug", config.slug || "library").single();
        if (error) throw error;
        snapshot = data?.payload;
      } else {
        const response = await fetch(`/api/viewer/snapshot?at=${Date.now()}`, {cache: "no-store"});
        if (!response.ok) throw new Error("로컬 열람 사본을 불러오지 못했습니다.");
        snapshot = await response.json();
      }
      if (!snapshot || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.notes)) throw new Error("열람 데이터 형식이 올바르지 않습니다.");
      try { localStorage.setItem("blue-brown-viewer-snapshot", JSON.stringify(snapshot)); } catch (_error) {}
    } catch (error) {
      try { snapshot = JSON.parse(localStorage.getItem("blue-brown-viewer-snapshot") || "null"); } catch (_error) {}
      if (!snapshot) throw error;
      showMessage("네트워크에 연결되지 않아 마지막 열람 사본을 표시합니다.", 4800);
    }
    state.snapshot = snapshot;
    renderSnapshot();
  }

  async function showViewer() {
    elements.auth.classList.add("hidden");
    elements.shell.classList.remove("hidden");
    elements.signOut.classList.toggle("hidden", !hasCloudConfig);
    await loadSnapshot();
    setLoading(true);
  }

  async function initialize() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    if (!hasCloudConfig) {
      await showViewer();
      return;
    }
    if (!window.supabase?.createClient) throw new Error("Supabase 열람 모듈을 불러오지 못했습니다.");
    state.client = window.supabase.createClient(config.supabaseUrl, config.publishableKey);
    const {data} = await state.client.auth.getSession();
    if (data.session) await showViewer();
    else {
      elements.auth.classList.remove("hidden");
      elements.shell.classList.add("hidden");
      setLoading(true);
    }
  }

  elements.authForm.addEventListener("submit", async event => {
    event.preventDefault();
    elements.authSubmit.disabled = true;
    elements.authStatus.textContent = "서재를 열고 있습니다.";
    const {error} = await state.client.auth.signInWithPassword({
      email: elements.authEmail.value.trim(),
      password: elements.authPassword.value,
    });
    if (error) {
      elements.authStatus.textContent = "이메일 또는 비밀번호를 확인하세요.";
      elements.authPassword.select();
    } else await showViewer();
    elements.authSubmit.disabled = false;
  });
  elements.signOut.addEventListener("click", async () => { await state.client?.auth.signOut(); location.reload(); });
  elements.refresh.addEventListener("click", async () => { await loadSnapshot(); showMessage("최신 열람 사본을 불러왔습니다."); });
  elements.tabs.forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  elements.projectSelect.addEventListener("change", () => selectProject(elements.projectSelect.value));
  elements.projectList.addEventListener("click", event => { const button = event.target.closest("[data-project]"); if (button) selectProject(button.dataset.project); });
  elements.fitBoard.addEventListener("click", () => fitBoard());
  elements.expandNav.addEventListener("click", () => { state.allNavExpanded = !state.allNavExpanded; state.expandedNav.clear(); renderNav(); });
  elements.noteSearch.addEventListener("input", renderNotes);
  elements.toggleNoteSources.addEventListener("click", () => {
    const project = currentProject();
    if (!project) return;
    const query = elements.noteSearch.value.trim().toLocaleLowerCase();
    const groups = noteSourceGroups(projectNotes(project).filter(note => !query || [note.title, note.body, note.paperTitle, note.paperAuthor].join(" ").toLocaleLowerCase().includes(query)));
    const shouldExpand = groups.length > 0 && groups.every(group => state.collapsedNoteSources.has(noteSourceStateKey(project, group.key)));
    groups.forEach(group => {
      const key = noteSourceStateKey(project, group.key);
      if (shouldExpand) state.collapsedNoteSources.delete(key); else state.collapsedNoteSources.add(key);
    });
    renderNotes();
  });
  elements.readerBack.addEventListener("click", () => {
    elements.readerPanel.classList.remove("open");
    state.readerCopyText = "";
    elements.readerCopy.classList.add("hidden");
  });
  elements.readerCopy.addEventListener("click", async () => {
    if (!state.readerCopyText) return;
    try {
      await copyText(state.readerCopyText);
      showMessage("현재 미리보기를 복사했습니다.");
    } catch (_error) {
      showMessage("복사하지 못했습니다.");
    }
  });

  [elements.boardStage, elements.navTree].forEach(container => container.addEventListener("click", event => {
    const target = event.target.closest("[data-endpoint]");
    if (target) openEndpoint(target.dataset.endpoint);
  }));
  [elements.noteList, elements.readerContent].forEach(container => container.addEventListener("click", event => {
    const target = event.target.closest("[data-note-id]");
    if (target) openNote(target.dataset.noteId);
  }));
  elements.noteList.addEventListener("click", event => {
    const toggle = event.target.closest("[data-note-source-toggle]");
    if (!toggle) return;
    const project = currentProject();
    if (!project) return;
    const key = noteSourceStateKey(project, toggle.dataset.noteSourceToggle);
    if (state.collapsedNoteSources.has(key)) state.collapsedNoteSources.delete(key); else state.collapsedNoteSources.add(key);
    renderNotes();
  });
  elements.navTree.addEventListener("click", event => {
    const toggle = event.target.closest("[data-nav-toggle]");
    if (!toggle) return;
    const id = toggle.dataset.navToggle;
    state.allNavExpanded = false;
    if (state.expandedNav.has(id)) state.expandedNav.delete(id); else state.expandedNav.add(id);
    renderNav();
  });

  elements.boardViewport.addEventListener("pointerdown", event => {
    const overBox = Boolean(event.target.closest(".board-box"));
    if (overBox && event.pointerType === "mouse") return;
    event.preventDefault();
    elements.boardViewport.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, {x: event.clientX, y: event.clientY, overBox});
    if (state.pointers.size === 1) state.gesture = overBox
      ? {type: "pending"}
      : {type: "pan", x: event.clientX, y: event.clientY, originX: state.transform.x, originY: state.transform.y};
    if (state.pointers.size === 2) {
      const [a, b] = [...state.pointers.values()];
      const rect = elements.boardViewport.getBoundingClientRect();
      state.gesture = {type: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.transform.zoom, x: state.transform.x, y: state.transform.y, centerX: (a.x + b.x) / 2 - rect.left, centerY: (a.y + b.y) / 2 - rect.top};
    }
    elements.boardViewport.classList.add("panning");
  });
  elements.boardViewport.addEventListener("pointermove", event => {
    if (!state.pointers.has(event.pointerId)) return;
    const previous = state.pointers.get(event.pointerId);
    state.pointers.set(event.pointerId, {x: event.clientX, y: event.clientY, overBox: previous.overBox});
    if (state.gesture?.type === "pan" && state.pointers.size === 1) {
      state.transform.x = state.gesture.originX + event.clientX - state.gesture.x;
      state.transform.y = state.gesture.originY + event.clientY - state.gesture.y;
    } else if (state.gesture?.type === "pinch" && state.pointers.size >= 2) {
      const [a, b] = [...state.pointers.values()];
      const rect = elements.boardViewport.getBoundingClientRect();
      const centerX = (a.x + b.x) / 2 - rect.left, centerY = (a.y + b.y) / 2 - rect.top;
      const nextZoom = Math.max(0.25, Math.min(2.5, state.gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, state.gesture.distance)));
      const worldX = (state.gesture.centerX - state.gesture.x) / state.gesture.zoom;
      const worldY = (state.gesture.centerY - state.gesture.y) / state.gesture.zoom;
      state.transform.zoom = nextZoom;
      state.transform.x = centerX - worldX * nextZoom;
      state.transform.y = centerY - worldY * nextZoom;
    }
    applyTransform();
  });
  const endPointer = event => {
    state.pointers.delete(event.pointerId);
    if (!state.pointers.size) { state.gesture = null; elements.boardViewport.classList.remove("panning"); }
    else {
      const pointer = [...state.pointers.values()][0];
      state.gesture = pointer.overBox
        ? {type: "pending"}
        : {type: "pan", x: pointer.x, y: pointer.y, originX: state.transform.x, originY: state.transform.y};
    }
  };
  elements.boardViewport.addEventListener("pointerup", endPointer);
  elements.boardViewport.addEventListener("pointercancel", endPointer);
  elements.boardViewport.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = elements.boardViewport.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const nextZoom = Math.max(0.25, Math.min(2.5, state.transform.zoom * Math.exp(-event.deltaY * 0.0015)));
    const worldX = (x - state.transform.x) / state.transform.zoom, worldY = (y - state.transform.y) / state.transform.zoom;
    state.transform.x = x - worldX * nextZoom; state.transform.y = y - worldY * nextZoom; state.transform.zoom = nextZoom;
    applyTransform();
  }, {passive: false});

  window.addEventListener("resize", () => { if (state.view === "board") fitBoard(false); });
  initialize().catch(error => {
    setLoading(true);
    elements.auth.classList.remove("hidden");
    elements.authStatus.textContent = error.message || String(error);
  });
})();
