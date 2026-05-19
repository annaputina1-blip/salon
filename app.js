const formatRub = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

const serviceInputs = Array.from(document.querySelectorAll("[data-service]"));
const discountInput = document.querySelector("#courseDiscount");
const totalPrice = document.querySelector("#totalPrice");
const selectedServices = document.querySelector("#selectedServices");
const bookingLink = document.querySelector("#calcBookingLink");
const messageField = document.querySelector("#clientMessage");

function updateCalculator() {
  const selected = serviceInputs
    .filter((input) => input.checked)
    .map((input) => ({
      title: input.dataset.service,
      price: Number(input.dataset.price),
    }));

  const rawTotal = selected.reduce((sum, item) => sum + item.price, 0);
  const hasDiscount = discountInput.checked && rawTotal > 0;
  const total = hasDiscount ? Math.round(rawTotal * 0.9) : rawTotal;
  const titles = selected.map((item) => item.title);

  totalPrice.textContent = formatRub.format(total);
  selectedServices.textContent = titles.length
    ? `${titles.join(", ")}${hasDiscount ? ". Скидка 10% применена." : ""}`
    : "Выберите услуги, чтобы увидеть расчет";

  const text = titles.length
    ? `Здравствуйте! Хочу записаться: ${titles.join(", ")}. Ориентир по стоимости: ${formatRub.format(total)}.`
    : "Здравствуйте! Хочу записаться на консультацию.";

  bookingLink.href = "#booking";
  bookingLink.dataset.message = text;
}

serviceInputs.forEach((input) => input.addEventListener("change", updateCalculator));
discountInput.addEventListener("change", updateCalculator);

bookingLink.addEventListener("click", () => {
  const text = bookingLink.dataset.message;
  if (text) {
    messageField.value = text;
  }
});

document.querySelector(".booking-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.querySelector("#clientName").value.trim() || "Имя не указано";
  const phone = document.querySelector("#clientPhone").value.trim() || "Телефон не указан";
  const message = messageField.value.trim() || "Услуга не указана";

  document.querySelector("#bookingResult").textContent =
    `Заявка подготовлена:\n${name}\n${phone}\n${message}\n\nПодключите WhatsApp, Telegram, почту или CRM, чтобы отправлять ее автоматически.`;
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
