const formatRub = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

const serviceInputs = Array.from(document.querySelectorAll("[data-service]"));
const discountInput = document.querySelector("#courseDiscount");
const extraDiscount = document.querySelector("#extraDiscount");
const promoCode = document.querySelector("#promoCode");
const totalPrice = document.querySelector("#totalPrice");
const rawTotalNode = document.querySelector("#rawTotal");
const discountAmountNode = document.querySelector("#discountAmount");
const selectedServices = document.querySelector("#selectedServices");
const bookingLink = document.querySelector("#calcBookingLink");
const messageField = document.querySelector("#clientMessage");
const requestSummary = document.querySelector("#requestSummary");

let lastCalculation = {
  selected: [],
  rawTotal: 0,
  discountAmount: 0,
  total: 0,
  discountLabels: [],
};

function getPromoDiscount(value) {
  const code = value.trim().toUpperCase();

  if (code === "LASER10") return { percent: 10, label: "промокод LASER10 - 10%" };
  if (code === "LPG15") return { percent: 15, label: "промокод LPG15 - 15%" };
  if (code === "BEAUTY5") return { percent: 5, label: "промокод BEAUTY5 - 5%" };

  return null;
}

function isCourseDiscountEligible(selected) {
  return selected.some((item) => /курс|комплекс|все тело/i.test(item.title));
}

function getExternalDiscount() {
  const availableDiscounts = [];
  const extraPercent = Number(extraDiscount?.value || 0);

  if (extraPercent > 0) {
    const selectedOption = extraDiscount.options[extraDiscount.selectedIndex];
    availableDiscounts.push({
      percent: extraPercent,
      label: selectedOption.textContent,
    });
  }

  const promo = getPromoDiscount(promoCode?.value || "");
  if (promo) {
    availableDiscounts.push(promo);
  }

  return availableDiscounts.sort((a, b) => b.percent - a.percent)[0] || null;
}

function syncDiscountControls(selected) {
  if (!discountInput) return;

  const eligibleForCourseDiscount = isCourseDiscountEligible(selected);
  const externalDiscount = getExternalDiscount();
  const shouldDisableCourseDiscount = !eligibleForCourseDiscount || Boolean(externalDiscount);
  const discountLabel = discountInput.closest("label");

  if (shouldDisableCourseDiscount) {
    discountInput.checked = false;
  }

  discountInput.disabled = shouldDisableCourseDiscount;
  discountInput.title = shouldDisableCourseDiscount
    ? "Скидка 10% доступна только для комплекса, курса или услуги «Все тело» и не суммируется с другими скидками"
    : "";
  discountLabel?.classList.toggle("is-disabled", shouldDisableCourseDiscount);

  if (extraDiscount) {
    extraDiscount.disabled = discountInput.checked;
  }

  if (promoCode) {
    promoCode.disabled = discountInput.checked;
  }
}

function buildCalculation() {
  const selected = serviceInputs
    .filter((input) => input.checked)
    .map((input) => ({
      title: input.dataset.service,
      price: Number(input.dataset.price),
    }));

  const rawTotal = selected.reduce((sum, item) => sum + item.price, 0);
  const discounts = [];

  syncDiscountControls(selected);

  if (discountInput?.checked && rawTotal > 0 && isCourseDiscountEligible(selected)) {
    discounts.push({ percent: 10, label: "скидка на курс/комплекс - 10%" });
  } else {
    const externalDiscount = getExternalDiscount();
    if (externalDiscount && rawTotal > 0) {
      discounts.push(externalDiscount);
    }
  }

  const totalDiscountPercent = discounts[0]?.percent || 0;
  const discountAmount = Math.round((rawTotal * totalDiscountPercent) / 100);
  const total = rawTotal - discountAmount;

  return {
    selected,
    rawTotal,
    discountAmount,
    total,
    discountLabels: discounts.map((item) => item.label),
  };
}

function createRequestText(calculation = lastCalculation) {
  const titles = calculation.selected.map((item) => item.title);
  const discountText = calculation.discountLabels.length
    ? ` Скидка: ${calculation.discountLabels.join(", ")}. Сумма скидки: ${formatRub.format(calculation.discountAmount)}.`
    : "";

  return titles.length
    ? `Здравствуйте! Хочу записаться: ${titles.join(", ")}. Стоимость до скидки: ${formatRub.format(calculation.rawTotal)}.${discountText} Итого: ${formatRub.format(calculation.total)}.`
    : "Здравствуйте! Хочу записаться на консультацию.";
}

function updateCalculator() {
  if (!serviceInputs.length || !totalPrice || !selectedServices) return;

  const calculation = buildCalculation();
  lastCalculation = calculation;
  const titles = calculation.selected.map((item) => item.title);

  totalPrice.textContent = formatRub.format(calculation.total);
  selectedServices.textContent = titles.length
    ? `${titles.join(", ")}${calculation.discountLabels.length ? `. Применено: ${calculation.discountLabels.join(", ")}.` : ""}`
    : "Выберите услуги, чтобы увидеть расчет";

  if (rawTotalNode) rawTotalNode.textContent = formatRub.format(calculation.rawTotal);
  if (discountAmountNode) discountAmountNode.textContent = formatRub.format(calculation.discountAmount);

  const requestText = createRequestText(calculation);
  if (bookingLink) bookingLink.dataset.message = requestText;
  if (messageField && document.body.classList.contains("calculator-page")) {
    messageField.value = requestText;
  }
  if (requestSummary) {
    requestSummary.textContent = titles.length
      ? requestText
      : "Расчет появится после выбора услуг.";
  }
}

serviceInputs.forEach((input) => input.addEventListener("change", updateCalculator));
discountInput?.addEventListener("change", updateCalculator);
extraDiscount?.addEventListener("change", updateCalculator);
promoCode?.addEventListener("input", updateCalculator);

bookingLink?.addEventListener("click", () => {
  const text = bookingLink.dataset.message;
  if (text && messageField) {
    messageField.value = text;
  }
});

const bookingForm = document.querySelector(".booking-form");
bookingForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  const name = document.querySelector("#clientName")?.value.trim() || "Имя не указано";
  const phone = document.querySelector("#clientPhone")?.value.trim() || "Телефон не указан";
  const date = document.querySelector("#clientDate")?.value.trim();
  const message = messageField?.value.trim() || createRequestText();
  const dateLine = date ? `\nУдобное время: ${date}` : "";
  const output = document.querySelector("#bookingResult");

  if (output) {
    output.textContent =
      `Заявка подготовлена:\n${name}\n${phone}${dateLine}\n${message}\n\nПодключите WhatsApp, Telegram, почту или CRM, чтобы отправлять ее автоматически.`;
  }
});

const slider = document.querySelector("[data-slider]");
if (slider) {
  const track = slider.querySelector(".slider-track");
  const slides = Array.from(slider.querySelectorAll(".review-card"));
  const prev = slider.querySelector("[data-slider-prev]");
  const next = slider.querySelector("[data-slider-next]");
  const dots = slider.querySelector("[data-slider-dots]");
  let index = 0;

  slides.forEach((_, dotIndex) => {
    const dot = document.createElement("button");
    dot.className = "slider-dot";
    dot.type = "button";
    dot.setAttribute("aria-label", `Показать отзыв ${dotIndex + 1}`);
    dot.addEventListener("click", () => {
      index = dotIndex;
      updateSlider();
    });
    dots.append(dot);
  });

  function visibleSlides() {
    if (window.matchMedia("(max-width: 720px)").matches) return 1;
    if (window.matchMedia("(max-width: 980px)").matches) return 2;
    return 3;
  }

  function updateSlider() {
    const maxIndex = Math.max(0, slides.length - visibleSlides());
    index = Math.min(Math.max(index, 0), maxIndex);
    const step = slides[0].getBoundingClientRect().width + 18;
    track.style.transform = `translateX(${-index * step}px)`;
    Array.from(dots.children).forEach((dot, dotIndex) => {
      dot.classList.toggle("active", dotIndex === index);
    });
  }

  prev.addEventListener("click", () => {
    index -= 1;
    updateSlider();
  });

  next.addEventListener("click", () => {
    index += 1;
    updateSlider();
  });

  window.addEventListener("resize", updateSlider);
  updateSlider();
}

updateCalculator();
