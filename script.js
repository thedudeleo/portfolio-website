

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();

        document.querySelector(this.getAttribute('href')).scrollIntoView({
            behavior: 'smooth'
        });
    });
});

document.addEventListener('DOMContentLoaded', () => {
    const swiper = new Swiper('.swiper', {
      // Optional parameters
      direction: 'horizontal',
        loop: true,
        autoHeight: true,
        autoplay: {
            delay: 5000,
        },

    
      // Navigation arrows
      navigation: {
        nextEl: '.swiper-button-next',
        prevEl: '.swiper-button-prev',
      },

  
    });
});