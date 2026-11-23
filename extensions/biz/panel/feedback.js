const locales = {
  es: {
    heading: 'Reportar a Fyso', 'report-label': 'Ruta o ID del reporte local',
    'load-button': 'Revisar reporte', 'title-label': 'Título', 'body-label': 'Contenido para GitHub',
    'related-label': 'Ruta o ID del reporte original (opcional)',
    review: 'Revisá el contenido y quitá datos personales, credenciales o información privada antes de enviarlo.',
    'send-button': 'Enviar a GitHub', invalid: 'Ingresá una ruta o ID de reporte válido.',
    missing: 'No encontramos el reporte local.', denied: 'Iniciá sesión en Biz con permiso para enviar reportes.',
    error: 'No se pudo completar la operación. Podés volver a intentarlo.',
    pending: 'El envío está pendiente de confirmación. Revisá el estado antes de crear otro reporte.',
    sent: 'Reporte recibido en GitHub.',
    persistencePending: 'GitHub recibió el reporte. Volvé a revisarlo para guardar el recibo localmente.',
  },
  en: {
    heading: 'Report to Fyso', 'report-label': 'Local report path or ID',
    'load-button': 'Review report', 'title-label': 'Title', 'body-label': 'Content for GitHub',
    'related-label': 'Original report path or ID (optional)',
    review: 'Review the contents and remove personal data, credentials, or private information before sending.',
    'send-button': 'Send to GitHub', invalid: 'Enter a valid report path or ID.',
    missing: 'The local report could not be found.', denied: 'Sign in to Biz with permission to submit feedback.',
    error: 'The operation could not be completed. You can try again.',
    pending: 'The submission is awaiting confirmation. Check its status before creating another report.',
    sent: 'GitHub received the report.',
    persistencePending: 'GitHub received the report. Review it again to save the receipt locally.',
  },
};
const lang = navigator.language.startsWith('en') ? 'en' : 'es';
document.documentElement.lang = lang;
const copy = locales[lang];
const el = id => document.getElementById(id);
for (const [key, value] of Object.entries(copy)) if (el(key)) el(key).textContent = value;
document.title = copy.heading;
const api = '/api/ext/biz/profile/feedback';
const idOf = value => value.trim().match(/^(?:project\/wiki\/feedback\/)?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.md)?$/)?.[1];
let current;

async function execute(fn) {
  el('load-button').disabled = true;
  el('send-button').disabled = true;
  el('status').textContent = '';
  el('issue').hidden = true;
  try { await fn(); }
  catch { el('status').textContent = copy.error; }
  finally {
    el('load-button').disabled = false;
    el('send-button').disabled = false;
  }
}

function showError(status) {
  el('status').textContent = ({403: copy.denied, 404: copy.missing, 409: copy.pending})[status] || copy.error;
}

function showReceipt(receipt) {
  el('status').textContent = receipt.persistencePending ? copy.persistencePending : copy.sent;
  el('issue').href = receipt.url;
  el('issue').textContent = '#' + receipt.number;
  el('issue').hidden = false;
}

el('load').addEventListener('submit', event => {
  event.preventDefault();
  void execute(async () => {
    el('send').hidden = true;
    current = undefined;
    const id = idOf(el('report-path').value);
    if (!id) { el('status').textContent = copy.invalid; return; }
    const response = await fetch(api + '?id=' + id);
    if (!response.ok) return showError(response.status);
    current = await response.json();
    if (current.receipt) return showReceipt(current.receipt);
    el('title').value = current.title;
    el('body').value = current.body;
    el('related').value = current.body.match(/^[-*] Related report:\s*(project\/wiki\/feedback\/[0-9a-f-]+\.md)\s*$/m)?.[1] || '';
    el('send').hidden = false;
  });
});

el('send').addEventListener('submit', event => {
  event.preventDefault();
  if (!current) return;
  void execute(async () => {
    const relatedValue = el('related').value.trim();
    const related = idOf(relatedValue);
    if (relatedValue && (!related || related === current.id)) { el('status').textContent = copy.invalid; return; }
    const response = await fetch(api, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id: current.id, related, title: el('title').value, body: el('body').value}),
    });
    if (!response.ok) return showError(response.status);
    showReceipt(await response.json());
    el('send').hidden = true;
  });
});
