

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();

        document.querySelector(this.getAttribute('href')).scrollIntoView({
            behavior: 'smooth'
        });
    });
});

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.swiper').forEach((swiperEl) => {
        // Use Swiper's auto-generated controls to avoid duplicate buttons
        // eslint-disable-next-line no-new
        new Swiper(swiperEl, {
            direction: 'horizontal',
            loop: true,
            autoHeight: true,
            autoplay: {
                delay: 5000,
            },
            createElements: true,
            navigation: true,
        });
    });
});