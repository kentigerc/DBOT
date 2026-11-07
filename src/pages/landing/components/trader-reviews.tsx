import { useCallback, useEffect, useRef, useState } from 'react';

// Trader feedback supplied by NetoAcademy. Preserve the original wording.
const reviews = [
    {
        name: 'Brian Mwangi',
        country: 'Kenya',
        flag: 'ke',
        text: "I started using NetoAcademy because I didn't have enough time to study charts every day. The automation setup was surprisingly easy, and the dashboard made everything straightforward.",
    },
    {
        name: 'Grace Wanjiku',
        country: 'Kenya',
        flag: 'ke',
        text: 'As a complete beginner, I appreciated how simple the platform felt. It helped me get started without feeling overwhelmed by technical analysis.',
    },
    {
        name: 'Samuel Okafor',
        country: 'Nigeria',
        flag: 'ng',
        text: 'The automated signals gave me more confidence when entering trades. I like that everything is clearly explained and easy to follow.',
    },
    {
        name: 'Chiamaka Nwosu',
        country: 'Nigeria',
        flag: 'ng',
        text: "I work full-time, so monitoring the markets constantly isn't possible for me. NetoAcademy helped bridge that gap with its automation features.",
    },
    {
        name: 'Thabo Mokoena',
        country: 'South Africa',
        flag: 'za',
        text: 'The interface is clean, modern, and easy to understand. Even people new to online trading can navigate it comfortably.',
    },
    {
        name: 'Lerato Khumalo',
        country: 'South Africa',
        flag: 'za',
        text: 'I was looking for a platform that could simplify trading decisions, and NetoAcademy delivered exactly that.',
    },
    {
        name: 'Rajesh Patel',
        country: 'India',
        flag: 'in',
        text: 'What impressed me most was how quickly I was able to set up my account and begin exploring automated trading strategies.',
    },
    {
        name: 'Priya Sharma',
        country: 'India',
        flag: 'in',
        text: 'The system helped reduce the stress of constantly watching price movements. Everything feels organized and user-friendly.',
    },
    {
        name: 'Ayesha Khan',
        country: 'Pakistan',
        flag: 'pk',
        text: 'The learning resources combined with automation make this platform stand out. It feels like a useful tool for beginners.',
    },
    {
        name: 'Hassan Raza',
        country: 'Pakistan',
        flag: 'pk',
        text: 'I liked how transparent the platform is. The setup process was smooth, and the automated features were simple to configure.',
    },
    {
        name: 'Daniel Phiri',
        country: 'Zambia',
        flag: 'zm',
        text: "I've tried a few trading platforms before, but the simplicity of NetoAcademy is what kept me using it.",
    },
    {
        name: 'Ruth Banda',
        country: 'Zambia',
        flag: 'zm',
        text: 'The platform looks professional and makes complex trading concepts easier to understand.',
    },
    {
        name: 'Kgomotso Molefe',
        country: 'Botswana',
        flag: 'bw',
        text: 'NetoAcademy helped me gain confidence in trading. I especially liked the automated strategy options.',
    },
    {
        name: 'Kabelo Modise',
        country: 'Botswana',
        flag: 'bw',
        text: "The experience has been smooth so far. I appreciate that the platform doesn't feel complicated or intimidating.",
    },
    {
        name: 'Joseph Mensah',
        country: 'Ghana',
        flag: 'gh',
        text: 'Everything from registration to activating automation was very straightforward. The design is excellent.',
    },
    {
        name: 'Abena Owusu',
        country: 'Ghana',
        flag: 'gh',
        text: 'The platform saves time and makes the trading process much easier for someone who is still learning.',
    },
    {
        name: 'Petrus Amutenya',
        country: 'Namibia',
        flag: 'na',
        text: 'I enjoy the clean interface and simple workflow. It helped me understand the basics much faster.',
    },
    {
        name: 'Helena Shilongo',
        country: 'Namibia',
        flag: 'na',
        text: "The automation features are easy to access and don't require advanced trading knowledge to get started.",
    },
    {
        name: 'Faridah Ahmad',
        country: 'Malaysia',
        flag: 'my',
        text: "I liked how the platform combines convenience with educational content. It's great for busy people.",
    },
    {
        name: 'Muhammad Iqbal',
        country: 'Malaysia',
        flag: 'my',
        text: 'The automated trading tools are easy to understand, and the overall user experience feels polished and professional.',
    },
];

export default function TraderReviews() {
    const track = useRef<HTMLUListElement>(null);
    const [edges, setEdges] = useState({ start: true, end: false });
    const updateEdges = useCallback(() => {
        const element = track.current;
        if (element)
            setEdges({
                start: element.scrollLeft <= 1,
                end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
            });
    }, []);
    useEffect(() => {
        updateEdges();
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateEdges) : undefined;
        if (track.current) observer?.observe(track.current);
        return () => observer?.disconnect();
    }, [updateEdges]);
    const scroll = (direction: number) => {
        const element = track.current;
        if (!element) return;
        const card = element.firstElementChild as HTMLElement | null;
        element.scrollBy({
            left: direction * ((card?.offsetWidth || element.clientWidth) + 20),
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
    };
    return (
        <section className='nl-reviews nl-section' id='reviews' aria-labelledby='nl-reviews-heading'>
            <div className='nl-reviews__heading'>
                <div>
                    <p className='nl-eyebrow'>FROM THE COMMUNITY</p>
                    <h2 id='nl-reviews-heading'>In our traders’ words.</h2>
                    <p className='nl-reviews__intro'>Experiences from people using NetoAcademy.</p>
                </div>
                <div className='nl-reviews__controls'>
                    <button
                        type='button'
                        aria-label='Previous reviews'
                        aria-controls='nl-reviews-track'
                        disabled={edges.start}
                        onClick={() => scroll(-1)}
                    >
                        <span aria-hidden='true'>←</span>
                    </button>
                    <button
                        type='button'
                        aria-label='Next reviews'
                        aria-controls='nl-reviews-track'
                        disabled={edges.end}
                        onClick={() => scroll(1)}
                    >
                        <span aria-hidden='true'>→</span>
                    </button>
                </div>
            </div>
            <p className='nl-reviews__hint' id='nl-reviews-hint'>
                Swipe, scroll sideways or use the arrows to read more.
            </p>
            <ul
                className='nl-reviews__track'
                id='nl-reviews-track'
                ref={track}
                tabIndex={0}
                aria-label='Trader reviews'
                aria-describedby='nl-reviews-hint'
                onScroll={updateEdges}
            >
                {reviews.map(review => (
                    <li className='nl-reviews__card' key={review.name}>
                        <figure>
                            <span className='nl-reviews__quote' aria-hidden='true'>
                                “
                            </span>
                            <blockquote>
                                <p>{review.text}</p>
                            </blockquote>
                            <figcaption>
                                <span className='nl-reviews__avatar' aria-hidden='true'>
                                    {review.name
                                        .split(' ')
                                        .map(part => part[0])
                                        .join('')}
                                </span>
                                <div>
                                    <cite>{review.name}</cite>
                                    <span className='nl-reviews__country'>
                                        <img
                                            src={`/assets/flags/${review.flag}.svg`}
                                            width='24'
                                            height='18'
                                            alt=''
                                            loading='lazy'
                                        />
                                        {review.country}
                                    </span>
                                </div>
                            </figcaption>
                        </figure>
                    </li>
                ))}
            </ul>
        </section>
    );
}
