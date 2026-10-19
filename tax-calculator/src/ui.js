const form = document.querySelector('form');
const income = document.querySelector('#income');
const payg = document.querySelector('#payg');
const results = document.querySelector('#results');
const money = cents => new Intl.NumberFormat('en-AU', {style:'currency', currency:'AUD'}).format(cents / 100);
const fields = {gross:'grossTaxCents', lito:'litoAppliedCents', net:'incomeTaxCents', medicare:'medicareCents', total:'totalTaxCents', remaining:'remainingCents'};
function update() {
  for (const id of ['income','payg']) {
    document.querySelector('#'+id+'-error').textContent = '';
    document.querySelector('#'+id).removeAttribute('aria-invalid');
  }
  try {
    const r = calculateTax({taxableIncome:income.value, paygWithheld:payg.value});
    for (const [id,key] of Object.entries(fields)) document.querySelector('#'+id).textContent = money(r[key]);
    document.querySelector('#rate').textContent = r.effectiveRatePercent.toFixed(2)+'%';
    document.querySelector('#income-caption').textContent = '应税收入 '+money(r.taxableIncome * 100)+' · FY2025–26';
    document.querySelector('#balance').textContent = r.balanceKind === null ? '未提供 PAYG，暂不估算补退税。'
      : r.balanceKind === 'exact' ? '预计补退税差额 $0.00（刚好抵足）'
      : (r.balanceKind === 'refund' ? '预计可退差额 ' : '预计需补差额 ')+money(Math.abs(r.paygDifferenceCents));
    document.querySelector('#invalid-notice').hidden = true;
    results.hidden = false;
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    document.querySelector('#'+e.field+'-error').textContent = e.message;
    document.querySelector('#'+e.field).setAttribute('aria-invalid','true');
    results.hidden = true;
    document.querySelector('#invalid-notice').hidden = false;
  }
}
form.addEventListener('submit', e => {e.preventDefault(); update();});
form.addEventListener('input', update);
document.querySelectorAll('[data-income]').forEach(b => b.addEventListener('click', () => {income.value=b.dataset.income;update();}));
document.querySelector('#print').addEventListener('click', () => window.print());
update();
