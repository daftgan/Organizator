/* ═══════════════════════════════════════════════════════════════════════════
   md.js — rendu Markdown des messages d'agent
   Commun à la fenêtre principale (journal d'une conversation, app.js) et à la fenêtre
   Conversations (conversations.js). Texte échappé d'abord : rien de ce que l'agent écrit ne
   devient du HTML actif ; seuls les liens http(s) deviennent cliquables (data-act="open-url",
   ouverts dans le navigateur par la page). Les lignes « [outil : X] » que l'hôte écrit pour les
   appels d'outils se regroupent en une ligne discrète (« Read ×3 · Edit · Bash »).
   window.OrganizatorMd = { esc, inline(texte), blocks(texte), tools(noms) }
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var TOOL_LINE = /^\s*\[outil\s*:\s*([^\]]*)\]\s*$/;
  var LIST_LINE = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
  var ICON = { tool: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.6 2.6l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.4-.4-2.4z"></path></svg>' };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mdLinkHtml(url, label) {
    return '<a class="md-link" draggable="false" data-act="open-url" data-url="' + esc(url)
      + '" title="' + esc(url) + '">' + esc(label) + '</a>';
  }

  /* Une ligne : code entre accents graves, liens, gras, italique, barré. Le code et les liens sont
     mis de côté avant l'échappement, pour que leur contenu ne soit pas réinterprété. */
  function mdInline(raw) {
    var keep = [];
    function hold(html) { keep.push(html); return '\u0000' + (keep.length - 1) + '\u0000'; }
    var s = String(raw == null ? '' : raw).replace(/\u0000/g, '');
    s = s.replace(/`([^`\n]+)`/g, function (m, code) { return hold('<code>' + esc(code) + '</code>'); });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, label, url) { return hold(mdLinkHtml(url, label)); });
    s = s.replace(/https?:\/\/[^\s<>"'`\u0000]+/g, function (m) {
      var url = m.replace(/[.,;:!?)\]]+$/, '');
      return hold(mdLinkHtml(url, url)) + m.slice(url.length);
    });
    s = esc(s)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__([^_\n]+?)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[+i]; });
  }

  /* Appels d'outils consécutifs : un nom par outil, dans l'ordre d'apparition, avec leur nombre.
     Un outil MCP (« mcp__bitbucket__get_diff ») se lit par son dernier segment. */
  function logToolsHtml(names) {
    var order = [], n = {};
    names.forEach(function (x) { if (!n[x]) { n[x] = 0; order.push(x); } n[x]++; });
    return '<div class="msg-tools" title="' + esc(names.length + (names.length > 1 ? ' appels d’outils : ' : ' appel d’outil : ') + order.join(', ')) + '">'
      + '<span class="msg-tools-icon">' + ICON.tool + '</span>'
      + order.map(function (x) {
        var short = /^mcp__/.test(x) ? x.split('__').pop() : x;
        return '<span class="msg-tool">' + esc(short) + (n[x] > 1 ? '<span class="msg-tool-n">×' + n[x] + '</span>' : '') + '</span>';
      }).join('') + '</div>';
  }

  function mdTableHtml(rows) {
    function cells(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
    }
    var head = cells(rows[0]);
    return '<div class="md-table-wrap"><table class="md-table"><thead><tr>'
      + head.map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + rows.slice(1).map(function (r) {
        return '<tr>' + cells(r).map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* Blocs : code délimité, lignes d'outils, titres, filets, tableaux, citations, listes (cases à
     cocher comprises, numérotation gardée d'un bloc à l'autre), paragraphes. */
  function mdBlocksHtml(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], list = null, i = 0;
    function flushPara() { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } }
    function flushList() { if (list) { out.push('<' + list.tag + ' class="md-list">' + list.items.join('') + '</' + list.tag + '>'); list = null; } }
    function flush() { flushPara(); flushList(); }
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*(`{3,}|~{3,})\s*[\w+#.-]*\s*$/.exec(line);
      if (fence) {
        flush();
        var close = new RegExp('^\\s*' + (fence[1].charAt(0) === '`' ? '`' : '~') + '{' + fence[1].length + ',}\\s*$');
        var code = [];
        for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
        i++;
        out.push('<pre class="md-code"><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (TOOL_LINE.test(line)) {
        flush();
        var names = [];
        while (i < lines.length && (TOOL_LINE.test(lines[i]) || (!lines[i].trim() && TOOL_LINE.test(lines[i + 1] || '')))) {
          var t = TOOL_LINE.exec(lines[i]);
          if (t) names.push(t[1].trim() || '?');
          i++;
        }
        out.push(logToolsHtml(names));
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      var h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) { flush(); out.push('<div class="md-h md-h' + Math.min(h[1].length, 4) + '">' + mdInline(h[2]) + '</div>'); i++; continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr class="md-hr">'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
        flush();
        var rows = [line];
        for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
        out.push(mdTableHtml(rows));
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        flush();
        var quote = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        out.push('<blockquote class="md-quote">' + quote.map(mdInline).join('<br>') + '</blockquote>');
        continue;
      }
      var li = LIST_LINE.exec(line);
      if (li) {
        flushPara();
        var tag = /\d/.test(li[2]) ? 'ol' : 'ul';
        var depth = Math.min(3, Math.floor(li[1].replace(/\t/g, '  ').length / 2));
        if (list && list.tag !== tag && !depth) flushList();
        if (!list) list = { tag: tag, items: [] };
        var box = /^\[([ xX])\]\s+(.*)$/.exec(li[3]);
        var item = box ? '<span class="md-box">' + (box[1] === ' ' ? '☐' : '☑') + '</span> ' + mdInline(box[2]) : mdInline(li[3]);
        /* Lignes suivantes en retrait : la suite du même élément. */
        for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_LINE.test(lines[i]) && !TOOL_LINE.test(lines[i]); i++) {
          item += '<br>' + mdInline(lines[i].trim());
        }
        list.items.push('<li' + (depth ? ' class="md-d' + depth + '"' : '')
          + (tag === 'ol' && !depth ? ' value="' + parseInt(li[2], 10) + '"' : '') + '>' + item + '</li>');
        continue;
      }
      flushList();
      para.push(line.trim());
      i++;
    }
    flush();
    return out.join('');
  }

  window.OrganizatorMd = { esc: esc, inline: mdInline, blocks: mdBlocksHtml, tools: logToolsHtml };
})();
