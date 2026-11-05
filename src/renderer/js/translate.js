// 邮件翻译：本地判断语言，不是中文就在正文上方给出“翻译成中文”；译文由 Claude 流式生成并缓存在本机。
import { h, escapeHtml } from './util.js';
import { icon } from './icons.js';
import { state, api } from './state.js';

// ---------- 语言判断（只用字符和常见虚词，不调用 AI） ----------
const STOPWORDS = {
  意大利语: ['il', 'di', 'che', 'e', 'la', 'per', 'un', 'una', 'del', 'della', 'con', 'non', 'sono', 'gli', 'al', 'dal', 'nel', 'anche', 'questo', 'ciao', 'grazie', 'buongiorno', 'cordiali', 'saluti', 'gentile', 'vi', 'si'],
  英语: ['the', 'and', 'to', 'of', 'you', 'is', 'for', 'in', 'your', 'this', 'that', 'with', 'are', 'on', 'be', 'we', 'our', 'have', 'will', 'please', 'thanks', 'regards', 'dear', 'hi'],
  法语: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'vous', 'pour', 'une', 'dans', 'que', 'qui', 'pas', 'avec', 'nous', 'sur', 'bonjour', 'merci', 'cordialement', 'votre'],
  德语: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'sie', 'ich', 'mit', 'für', 'auf', 'den', 'dem', 'ein', 'eine', 'zu', 'wir', 'ihre', 'bitte', 'danke', 'grüße', 'hallo'],
  西班牙语: ['el', 'la', 'los', 'las', 'de', 'y', 'que', 'en', 'es', 'por', 'para', 'con', 'una', 'del', 'se', 'su', 'hola', 'gracias', 'saludos', 'usted', 'estimado'],
  葡萄牙语: ['o', 'a', 'os', 'as', 'de', 'e', 'que', 'em', 'um', 'uma', 'para', 'com', 'não', 'do', 'da', 'obrigado', 'olá', 'você', 'atenciosamente'],
  荷兰语: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'met', 'voor', 'op', 'zijn', 'je', 'wij', 'bedankt', 'groeten', 'hallo'],
};

export function detectLanguage(text) {
  const s = String(text || '').slice(0, 6000);
  const count = (re) => (s.match(re) || []).length;
  const han = count(/[一-鿿]/g);
  const kana = count(/[぀-ヿ]/g);
  const hangul = count(/[가-힯]/g);
  const cyr = count(/[Ѐ-ӿ]/g);
  const arab = count(/[؀-ۿ]/g);
  const latin = count(/[A-Za-zÀ-ÿ]/g);
  const total = han + kana + hangul + cyr + arab + latin;
  if (total < 30) return null;
  if (kana > 20 && kana / total > 0.05) return '日语';
  if (han / total > 0.25) return null; // 中文（或以中文为主），不需要翻译
  if (hangul / total > 0.3) return '韩语';
  if (cyr / total > 0.3) return '俄语';
  if (arab / total > 0.3) return '阿拉伯语';
  if (latin / total < 0.5) return null;
  const words = s.toLowerCase().match(/[a-zà-ÿ]+/g) || [];
  let best = '外语';
  let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    let n = 0;
    for (const w of words) if (set.has(w)) n++;
    if (n > bestScore) {
      bestScore = n;
      best = lang;
    }
  }
  return best;
}

// ---------- 译文显示 ----------
function linkify(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"')\]]+/g, (u) => `<a href="${u}">${u}</a>`);
}

function renderTranslation(el, { subject, body, truncated }) {
  el.innerHTML = `${subject ? `<div class="tr-subject">${escapeHtml(subject)}</div>` : ''}<div class="tr-body">${linkify(escapeHtml(body || ''))}</div>${
    truncated ? '<div class="tr-note muted">原文太长，只翻译了前面的部分。</div>' : ''
  }`;
}

let seq = 0;

// 在 header 和正文之间插一条翻译栏。original 是正文（iframe 外层）元素。
export function attachTranslator(msg, original) {
  const ref = { accountId: msg.accountId, path: msg.path, uid: msg.uid };
  const sample = `${msg.subject || ''}\n${msg.text || (msg.html || '').replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')}`;
  const lang = detectLanguage(sample);
  const bar = h('<div class="translate-bar"></div>');
  const view = h('<div class="translation hidden"></div>');
  let requestId = null;
  let off = null;
  let showing = 'original';
  let result = null;

  const show = (which) => {
    showing = which;
    view.classList.toggle('hidden', which !== 'translation');
    original.classList.toggle('hidden', which === 'translation');
  };

  const paint = (mode, extra = '') => {
    if (mode === 'offer') {
      bar.innerHTML = `${icon('languages', 15)}<span>这封邮件是${escapeHtml(lang || '外语')}</span><button class="btn btn-ghost btn-sm" data-a="go">翻译成中文</button>`;
    } else if (mode === 'working') {
      bar.innerHTML = `<span class="mini-spin"></span><span>正在用 Claude 翻译成中文…</span><button class="btn btn-ghost btn-sm" data-a="cancel">取消</button>`;
    } else if (mode === 'done') {
      bar.innerHTML = `${icon('languages', 15)}<span>${showing === 'translation' ? '已翻译成中文' : `这封邮件是${escapeHtml(lang || '外语')}`}</span><button class="btn btn-ghost btn-sm" data-a="toggle">${showing === 'translation' ? '显示原文' : '显示译文'}</button>`;
    } else if (mode === 'error') {
      bar.innerHTML = `<span class="state-dot danger"></span><span class="tr-err">${escapeHtml(extra)}</span><button class="btn btn-ghost btn-sm" data-a="go">重试</button>`;
    }
    bar.dataset.mode = mode;
  };

  const stop = () => {
    if (off) off();
    off = null;
  };

  const start = async () => {
    const cached = await api.ai.translation(ref).catch(() => null);
    if (cached && cached.body) {
      result = cached;
      renderTranslation(view, cached);
      show('translation');
      return paint('done');
    }
    requestId = 'tr' + ++seq + '_' + Date.now();
    paint('working');
    show('translation');
    view.innerHTML = '<div class="tr-wait"><span class="mini-spin"></span>正在翻译…</div>';
    stop();
    off = api.ai.onTranslate((e) => {
      if (e.requestId !== requestId) return;
      if (!bar.isConnected) return stop();
      if (e.type === 'delta') renderTranslation(view, e);
      else if (e.type === 'done') {
        stop();
        result = e;
        renderTranslation(view, e);
        paint('done');
      } else if (e.type === 'error') {
        stop();
        show('original');
        paint('error', e.message);
      } else if (e.type === 'cancelled') {
        stop();
        show('original');
        if (lang) paint('offer');
        else bar.classList.add('hidden');
      }
    });
    api.ai.translate({ requestId, ...ref }).catch((err) => {
      stop();
      show('original');
      paint('error', err.message);
    });
  };

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'go') start();
    if (b.dataset.a === 'cancel' && requestId) api.ai.cancelTranslate(requestId);
    if (b.dataset.a === 'toggle') {
      show(showing === 'translation' ? 'original' : 'translation');
      paint('done');
    }
  });
  view.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    api.app.openExternal(a.getAttribute('href'));
  });

  // 外语邮件：显示提示；已经翻译过的直接用缓存；开了“自动翻译”就直接开始
  if (lang) {
    paint('offer');
    api.ai.translation(ref).then((cached) => {
      if (cached && cached.body && bar.dataset.mode === 'offer') {
        result = cached;
        renderTranslation(view, cached);
        if (state.settings.autoTranslate) show('translation');
        paint('done');
      } else if (state.settings.autoTranslate && bar.dataset.mode === 'offer') start();
    });
  } else {
    bar.classList.add('hidden');
  }

  return {
    bar,
    view,
    // 工具栏的“翻译”按钮：不是外语也能强制翻译
    run() {
      bar.classList.remove('hidden');
      if (bar.dataset.mode === 'working') return;
      if (result) {
        show(showing === 'translation' ? 'original' : 'translation');
        return paint('done');
      }
      start();
    },
    dispose: stop,
  };
}
