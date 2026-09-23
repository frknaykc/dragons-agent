const input = document.getElementById('secret');
const form = document.getElementById('secret-form');
const error = document.getElementById('error');
let submitting = false;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  if (!/^[\x21-\x7e]{1,8192}$/.test(input.value)) {
    input.value = '';
    error.textContent = 'Enter one printable key without whitespace.';
    return;
  }
  submitting = true;
  let value = input.value;
  input.value = '';
  try {
    const result = window.dragonsSecret.submit(value);
    value = undefined;
    if (!await result) error.textContent = 'Unable to submit API key.';
  } catch { error.textContent = 'Unable to submit API key.'; }
  finally { value = undefined; submitting = false; }
});
function cancel() { input.value = ''; void window.dragonsSecret.submit(undefined).catch(() => {}); }
document.getElementById('cancel').addEventListener('click', cancel);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } });
window.addEventListener('pagehide', () => { input.value = ''; });
