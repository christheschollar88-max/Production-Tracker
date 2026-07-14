// This tells the browser that the app has a background worker, allowing it to be installed.
self.addEventListener('fetch', function(event) {
    // We are leaving this pass-through for now, but in the future, 
    // you can use this file to make the app work completely offline!
});