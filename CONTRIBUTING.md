# Contributing to Smart Mine Safety Control Center

First off, thank you for considering contributing to the **Smart Mine Safety Control Center**! It is through open-source contributions from engineers, researchers, and developers that safety technology advances.

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### 1. Reporting Bugs
- Check the issue tracker to see if the bug has already been reported.
- If not, create a new issue using our [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md).
- Include steps to reproduce, expected behavior, observed behavior, browser/OS version, and hardware configuration (if using ESP32).

### 2. Suggesting Features & Enhancements
- Open an issue using our [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.md).
- Describe the motivation, real-world underground mine application, and proposed technical architecture (e.g., LoRaWAN integration, Three.js 3D visualization, MQTT streaming).

### 3. Submitting Pull Requests
1. **Fork** the repository and clone it locally.
2. Create a clean branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Test your changes:
   - Ensure the UI renders correctly across both **Control Room View** and **Worker Mobile View**.
   - Ensure `app.js` runs cleanly without console errors.
   - Verify that all demo scenarios and the REST endpoint function as expected.
4. Keep commit messages descriptive:
   ```bash
   git commit -m "feat(routing): add alternate shaft bypass for Zone M3 hazard"
   ```
5. Push to your branch and open a Pull Request against `main`.

## Coding Guidelines

- **Vanilla Standards**: Preserve the zero-dependency, lightweight nature of the frontend. Avoid introducing large heavy frameworks unless discussed via an RFC issue.
- **Accessibility & Contrast**: All colors and telemetry cards must maintain high contrast suitable for dark control rooms and miners with limited lighting.
- **Hardware Agnostic**: Ensure the frontend API remains adaptable to ESP32, ESP8266, Raspberry Pi, Arduino, or MQTT bridges.
