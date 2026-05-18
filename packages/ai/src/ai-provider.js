export class AbstractAiProvider {
    config = {};
    configure(config) {
        this.config = { ...this.config, ...config };
    }
    isReady() {
        return true;
    }
}
