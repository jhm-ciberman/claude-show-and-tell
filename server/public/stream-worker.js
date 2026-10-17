// One live stream shared by every board tab. Chrome opens at most six connections to a host, and a stream per
// tab would hold one each, leaving the images and requests of the page waiting in line.
const TYPES = ['open', 'error', 'event', 'session', 'delivered', 'removed'];
const ports = new Set();
const source = new EventSource('/api/stream');
let isOpen = false;

function send(message) {
    for (const port of ports) {
        port.postMessage(message);
    }
}

for (const type of TYPES) {
    source.addEventListener(type, message => {
        if (type === 'open' || type === 'error') {
            isOpen = type === 'open';
        }

        send({ type, data: message.data ?? null });
    });
}

onconnect = event => {
    const [port] = event.ports;
    ports.add(port);
    port.start();

    // A tab that joins an open stream would otherwise never hear that it is live.
    if (isOpen) {
        port.postMessage({ type: 'open', data: null });
    }
};
