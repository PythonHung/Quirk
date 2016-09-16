import Axis from "src/math/Axis.js"
import CircuitDefinition from "src/circuit/CircuitDefinition.js"
import CircuitStats from "src/circuit/CircuitStats.js"
import Complex from "src/math/Complex.js"
import Config from "src/Config.js"
import DetailedError from "src/base/DetailedError.js"
import { drawCircuitTooltip } from "src/ui/DisplayedCircuit.js"
import Format from "src/base/Format.js"
import Gate from "src/circuit/Gate.js"
import GateColumn from "src/circuit/GateColumn.js"
import Hand from "src/ui/Hand.js"
import MathPainter from "src/draw/MathPainter.js"
import Matrix from "src/math/Matrix.js"
import Painter from "src/draw/Painter.js"
import Point from "src/math/Point.js"
import Rect from "src/math/Rect.js"
import Serializer from "src/circuit/Serializer.js"
import Util from "src/base/Util.js"
import { circuitDefinitionToGate } from "src/circuit/CircuitComputeUtil.js"
import { Observable, ObservableSource } from "src/base/Obs.js"
import { textEditObservable } from "src/browser/EventUtil.js"

/**
 * @param {!Revision} revision
 */
function initForge(revision) {
    const obsShow = new ObservableSource();
    const obsHide = new ObservableSource();
    const txtName = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-name');
    /** @type {!String} */
    let latestInspectorText;
    revision.latestActiveCommit().subscribe(e => { latestInspectorText = e; });

    // Show/hide exports overlay.
    (() => {
        const forgeButton = /** @type {!HTMLButtonElement} */ document.getElementById('gate-forge-button');
        const forgeOverlay = /** @type {!HTMLDivElement} */ document.getElementById('gate-forge-overlay');
        const forgeDiv = /** @type {HTMLDivElement} */ document.getElementById('gate-forge-div');
        forgeButton.addEventListener('click', () => {
            forgeDiv.style.display = 'block';
            txtName.value = '';
            obsShow.send(undefined);
        });
        obsHide.observable().subscribe(() => {
            forgeDiv.style.display = 'none';
        });
        forgeOverlay.addEventListener('click', () => {
            obsHide.send(undefined);
        });
        document.addEventListener('keydown', e => {
            const ESC_KEY = 27;
            if (e.keyCode === ESC_KEY) {
                obsHide.send(undefined);
            }
        });
    })();

    function computeAndPaintOp(canvas, opGetter, button) {
        button.disabled = true;
        let painter = new Painter(canvas);
        painter.clear();
        let d = Math.min((canvas.width - 5)/2, canvas.height);
        let rect1 = new Rect(0, 0, d, d);
        let rect2 = new Rect(d + 5, 0, d, d);
        try {
            let op = opGetter();
            MathPainter.paintMatrix(
                painter,
                op,
                rect1,
                Config.OPERATION_FORE_COLOR,
                'black',
                undefined,
                Config.OPERATION_BACK_COLOR,
                undefined,
                'transparent');
            if (op.width() === 2 && op.isUnitary(0.009)) {
                MathPainter.paintBlochSphereRotation(painter, op, rect2);
            }
            button.disabled = false;
        } catch (ex) {
            painter.printParagraph(
                ex+"",
                new Rect(0, 0, canvas.width, canvas.height),
                new Point(0, 0),
                'red',
                24);
        }
    }

    /**
     * @param {!Gate} gate
     * @param {undefined|!CircuitDefinition=undefined} circuitDef
     */
    function createCustomGateAndClose(gate, circuitDef=undefined) {
        let c = circuitDef || Serializer.fromJson(CircuitDefinition, JSON.parse(latestInspectorText));
        revision.commit(JSON.stringify(Serializer.toJson(c.withCustomGate(gate)), null, 0));
        obsHide.send(undefined);
    }

    (() => {
        const rotationCanvas = /** @type {!HTMLCanvasElement} */ document.getElementById('gate-forge-rotation-canvas');
        const rotationButton = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-rotation-button');
        const txtAxis = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-rotation-axis');
        const txtAngle = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-rotation-angle');
        const txtPhase = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-rotation-phase');

        function parseRotation() {
            let parseAngle = e => parseFloat(e.value === '' ? e.placeholder : e.value) * Math.PI / 180;
            let w = parseAngle(txtAngle);
            let phase = parseAngle(txtPhase);
            let {x, y, z} = Axis.parse(txtAxis.value === '' ? txtAxis.placeholder : txtAxis.value);

            let len = Math.sqrt(x*x + y*y + z*z);
            x /= len;
            y /= len;
            z /= len;

            let [I, X, Y, Z] = [Matrix.identity(2), Matrix.PAULI_X, Matrix.PAULI_Y, Matrix.PAULI_Z];
            let axisMatrix = X.times(x).plus(Y.times(y)).plus(Z.times(z));

            let result = I.times(Math.cos(w/2)).
                plus(axisMatrix.times(Complex.I.neg()).times(Math.sin(w/2))).
                times(Complex.polar(1, phase));
            if (result.hasNaN()) {
                throw new DetailedError("NaN", {x, y, z, result});
            }

            result = Matrix.parse(result.toString(new Format(true, 0.0000001, 7, ",")));
            return result;
        }

        let redraw = () => computeAndPaintOp(rotationCanvas, parseRotation, rotationButton);
        Observable.of(obsShow.observable(), ...[txtPhase, txtAxis, txtAngle].map(textEditObservable)).
            flatten().
            throttleLatest(100).
            subscribe(redraw);

        rotationButton.addEventListener('click', () => {
            let mat;
            try {
                mat = parseRotation();
            } catch (ex) {
                console.warn(ex);
                return; // Button is about to be disabled, so no handling required.
            }

            let gate = Gate.fromKnownMatrix(txtName.value, mat, 'Custom Rotation Gate', '').
                withSerializedId('~' + Math.floor(Math.random()*(1 << 20)).toString(32));
            createCustomGateAndClose(gate);
        });
    })();

    (() => {
        const matrixCanvas = /** @type {!HTMLCanvasElement} */ document.getElementById('gate-forge-matrix-canvas');
        const txtMatrix = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-matrix');
        const chkFix = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-matrix-fix');
        const matrixButton = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-matrix-button');

        function parseMatrix_noCorrection() {
            let s = txtMatrix.value;
            if (s === '') {
                s = txtMatrix.placeholder;
            }

            // If brackets are present, use the normal parse method that enforces grouping.
            if (s.match(/[\{}\[\]]/)) {
                return Matrix.parse(s.split(/[\{\[]/).join('{').split(/[}\]]/).join('}'));
            }

            // Newlines introduce a break if one isn't already present at that location and we aren't at the end.
            s = s.split(/,?\s*\n\s*(?!$)/).join(',');
            s = s.split(/\s/).join('');
            // Ignore trailing comma.
            if (s.endsWith(',')) {
                s = s.substring(0, s.length - 1);
            }

            let parts = s.split(',').map(e => e === '' ? 0 : Complex.parse(e));

            // Pad with zeroes up to next size that makes sense.
            let n = Math.max(4, 1 << (2*Math.max(1, Math.floor(Math.log2(Math.sqrt(parts.length))))));
            if (n < parts.length) {
                n <<= 2;
            }
            if (n > (1<<8)) {
                throw Error("Max custom matrix operation size is 4 qubits.")
            }
            //noinspection JSCheckFunctionSignatures
            return Matrix.square(...parts, ...new Array(n - parts.length).fill(0));
        }

        function parseMatrix() {
            let op = parseMatrix_noCorrection();
            if (op.width() !== op.height() || op.width() < 2 || op.width() > 16 || !Util.isPowerOf2(op.width())) {
                throw Error("Matrix must be 2x2, 4x4, 8x8, or 16x16.")
            }
            if (chkFix.checked) {
                op = op.closestUnitary(0.0001);
                op = Matrix.parse(op.toString(new Format(true, 0.0000001, 7, ",")));
            }
            return op;
        }

        let redraw = () => computeAndPaintOp(matrixCanvas, parseMatrix, matrixButton);

        Observable.of(obsShow.observable(), textEditObservable(txtMatrix), Observable.elementEvent(chkFix, 'change')).
            flatten().
            throttleLatest(100).
            subscribe(redraw);

        matrixButton.addEventListener('click', () => {
            let mat;
            try {
                mat = parseMatrix();
            } catch (ex) {
                console.warn(ex);
                return; // Button is about to be disabled, so no handling required.
            }

            let name = txtName.value.trim();
            let h = Math.round(Math.log2(mat.height()));
            let gate = Gate.fromKnownMatrix(name, mat, 'Custom Matrix Gate', '').
                withSerializedId('~' + Math.floor(Math.random()*(1 << 20)).toString(32)).
                withHeight(h).
                withWidth(name === '' ? h : 1);
            createCustomGateAndClose(gate);
        });
    })();

    (() => {
        const circuitCanvas = /** @type {!HTMLCanvasElement} */ document.getElementById('gate-forge-circuit-canvas');
        const txtCols = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-circuit-cols');
        const txtRows = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-circuit-rows');
        const spanInputs = /** @type {!HTMLElement} */ document.getElementById('gate-forge-circuit-inputs');
        const circuitButton = /** @type {!HTMLInputElement} */ document.getElementById('gate-forge-circuit-button');

        function parseRange(txtBox, maxLen) {
            let txt = txtBox.value === '' ? txtBox.placeholder : txtBox.value;
            let parts = txt.split(":").map(e => e.trim());
            if (parts.length > 2) {
                throw new Error("Too many colons.");
            }
            let min = parseInt(parts[0] || "1");
            let max = parts[1] === undefined || parts[1] === "" || parts[1] === "∞" ? Infinity : parseInt(parts[1]);
            if (isNaN(min)) {
                throw new Error("Not a number: " + parts[0]);
            }
            if (isNaN(max)) {
                throw new Error("Not a number: " + parts[1]);
            }

            let start = Math.min(maxLen, Math.max(0, min - 1));
            let end = Math.min(maxLen, Math.max(start, max));
            return {start, end};
        }

        function parseCircuitGate() {
            let circuit = Serializer.fromJson(CircuitDefinition, JSON.parse(latestInspectorText));
            let colRange = parseRange(txtCols, circuit.columns.length);
            let rowRange = parseRange(txtRows, circuit.numWires);
            if (rowRange.end === rowRange.start) {
                throw new Error("Empty wire range.")
            }

            let cols = circuit.columns.
                slice(colRange.start, colRange.end).
                map(col => new GateColumn(col.gates.slice(rowRange.start, rowRange.end)));
            let gateCircuit = new CircuitDefinition(rowRange.end - rowRange.start, cols).withUncoveredColumnsRemoved();
            if (gateCircuit.columns.length === 0) {
                throw new Error("No gates in included range.");
            }
            let minWired = gateCircuit.withMinimumWireCount();
            let extraWires = Math.max(0, minWired.numWires - gateCircuit.numWires);
            gateCircuit = minWired;

            let symbol = txtName.value.trim();
            let id = '~' + Math.floor(Math.random()*(1 << 20)).toString(32);

            let gate = circuitDefinitionToGate(
                gateCircuit,
                symbol,
                id,
                'A custom gate.')
                .withSerializedId(id);

            return {extraWires, gate, circuit};
        }

        let redraw = () => {
            circuitButton.disabled = true;
            let painter = new Painter(circuitCanvas);
            painter.clear();
            try {
                let {gate, extraWires} = parseCircuitGate();
                let keys = gate.getUnmetContextKeys();
                spanInputs.innerText = keys.size === 0 ?
                    "(none)" :
                    [...keys].map(e => e.replace("Input Range ", "")).join(", ");
                drawCircuitTooltip(
                    painter,
                    gate.knownCircuit.withDisabledReasonsForEmbeddedContext(
                        0,
                        new Map([...keys].map(e => [e, {offset: 0, length: 0}]))),
                    new Rect(0, 0, circuitCanvas.width, circuitCanvas.height),
                    true,
                    extraWires);
                circuitButton.disabled = false;
            } catch (ex) {
                painter.printParagraph(
                    ex+"",
                    new Rect(0, 0, circuitCanvas.width, circuitCanvas.height),
                    new Point(0, 0),
                    'red',
                    24);
            }
        };

        Observable.of(obsShow.observable(), textEditObservable(txtCols), textEditObservable(txtRows)).
            flatten().
            throttleLatest(100).
            subscribe(redraw);

        circuitButton.addEventListener('click', () => {
            try {
                let {gate, circuit} = parseCircuitGate();
                createCustomGateAndClose(gate, circuit);
            } catch (ex) {
                // Button is about to be disabled, so no handling required.
                console.warn(ex);
            }
        });
    })();
}

export { initForge }