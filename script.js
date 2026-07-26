function incrementCounter() {
    const counter = document.getElementById('counter');
    let count = parseInt(counter.textContent);
    counter.textContent = count + 1;
}

console.log('Website loaded successfully!');