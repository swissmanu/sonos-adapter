'use strict';

const Property = require('./property');
const ReadonlyProperty = require('./readonly-property');
const { Sonos } = require("sonos");

let Device, Constants;
try {
    Device = require('../device');
    Constants = require('../addon-constants');
}
catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
        throw e;
    }

    const gwa = require('gateway-addon');
    Device = gwa.Device;
    Constants = gwa.Constants;
}

function getModeFromProps(shuffle, repeat) {
    if(!shuffle && repeat === 'None') {
        return 'NORMAL';
    }
    else if(repeat === 'None') {
        return 'SHUFFLE_NOREPEAT';
    }
    else if(shuffle && repeat === 'All') {
        return 'SHUFFLE';
    }
    else if(repeat === 'All'){
        return 'REPEAT_ALL';
    }
    else if(shuffle && repeat === 'One') {
        return 'SHUFFLE_REPEAT_ONE';
    }
    else if(repeat === 'One') {
        return 'REPEAT_ONE';
    }
}

class Speaker extends Device {
    constructor(adapter, ip, device) {
        super(adapter, ip);

        this.device = device;
        this.name = ip;
        this.type = Constants.THING_TYPE_UNKNOWN_THING;
        this["@type"] = [ "Speaker", "MediaPlayer" ];

        this.properties.set('volume', new Property(this, 'volume', {
            label: "Volume",
            type: 'number',
            unit: 'percent',
            "@type": "LevelProperty"
        }, 100));
        this.properties.set('playing', new Property(this, 'playing', {
            label: "Play/Pause",
            type: 'boolean',
            "@type": "BooleanProperty"
        }, false));
        this.properties.set('shuffle', new Property(this, 'shuffle', {
            label: "Shuffle",
            type: 'boolean',
            "@type": "BooleanProperty"
        }, false));
        this.properties.set('repeat', new Property(this, 'repeat', {
            label: "Repeat",
            type: 'string',
            "@type": "EnumProperty",
            enum: [
                'None',
                'One',
                'All',
            ]
        }, false));
        this.properties.set('crossfade', new Property(this, 'crossfade', {
            label: "Crossfade",
            type: "boolean",
            "@type": "BooleanProperty"
        }, false));
        this.properties.set('track', new ReadonlyProperty(this, 'track', {
            label: "Track",
            type: "string",
            "@type": "StringProperty"
        }, ''));
        this.properties.set('album', new ReadonlyProperty(this, 'album', {
            label: "Album",
            type: "string",
            "@type": "StringProperty"
        }, ''));
        this.properties.set('artist', new ReadonlyProperty(this, 'artist', {
            label: "Artist",
            type: "string",
            "@type": "StringProperty"
        }, ''));
        this.properties.set('progress', new Property(this, 'progress', {
            label: "Progress",
            type: "number",
            "@type": "LevelProperty"
        }, 0));
        this.currentDuration = 0;
        this.currentPosition = 0;

        //TODO eq
        //TODO loudness
        //TODO balance for stereo pairs
        //TODO handle fixed volume setting changing
        //TODO actions? Like clear queue, stop
        //TODO fields like current track (album art), queue size
        //TODO queue track position property
        //TODO property for queue size/stopped?
        //TODO playback state when grouped
        //TODO play line-in
        //TODO action to play notification (needs file input and has a toggle for where to play)
        // Useful list of things: https://github.com/SoCo/SoCo/wiki/Sonos-UPnP-Services-and-Functions

        this.addAction('next', {
            label: "Next",
            description: "Skip current track and start playing next track in the queue"
        });
        this.addAction('prev', {
            label: "Previous",
            description: "Play previous track in the queue"
        });

        this.ready = this.fetchProperties().then(() => this.adapter.handleDeviceAdded(this));
    }

    async fetchProperties() {
        const name = await this.device.getName();
        this.setName(name);

        const supportsFixedVolume = await this.getSupportsFixedVolume();
        let shouldGetVolume = true;
        if(supportsFixedVolume) {
            const hasFixedVolume = await this.getFixedVolume();
            shouldGetVolume = !hasFixedVolume;
            if(hasFixedVolume) {
                //TODO make property read-only
            }
        }
        if(shouldGetVolume) {
            const volume = await this.device.getVolume();
            this.updateProp('volume', volume * 100);
        }

        const state = await this.device.getCurrentState();
        this.updateProp('playing', state === 'playing');

        const currentTrack = await this.device.currentTrack();
        if(currentTrack.duration > 0) {
            this.updateProp('track', currentTrack.title);
            this.updateProp('album', currentTrack.album);
            this.updateProp('artist', currentTrack.artist);
            this.updateProp('progress', (currentTrack.position / currentTrack.duration) * 100);
            this.currentDuration = currentTrack.duration;
            this.currentPosition = currentTrack.position;
            if(state === 'playing') {
                this.progressInterval = setInterval(() => this.updateProgress(), 1000);
            }
        }
        //TODO current track change event

        const mode = await this.device.getPlayMode();
        this.updatePlayMode(mode);

        const crossFade = await this.getCrossfadeMode();
        this.updateProp('crossfade', crossFade);

        const groups = await this.device.getAllGroups();
        const groupDetails = {
            label: "Group/Ungroup",
            description: "Group Sonos players",
            input: {
                type: "object",
                required: [],
                properties: {}
            }
        };
        const playerInfo = await this.device.getZoneInfo();
        const groupId = `RINCON_${playerInfo.MACAddress.replace(/:/g, '')}`;
        for(const zone of groups) {
            if(!zone.ID.startsWith(groupId)) {
                const zoneCoordinator = zone.ZoneGroupMember.find((m) => m.UUID === zone.Coordinator);
                if(zoneCoordinator.Invisible != '1') {
                    groupDetails.input.properties[zoneCoordinator.ZoneName] = {
                        type: "boolean",
                        default: zone.ZoneGroupMember.some((m) => m.UUID.startsWith(groupId))
                    };
                    groupDetails.input.required.push(zoneCoordinator.ZoneName);
                }
            }
        }
        this.addAction('group', groupDetails);

        this.device.on('PlayState', (state) => {
            const playing = state === 'playing';
            this.updateProp('playing', playing);
            if(playing && !this.progressInterval && this.currentDuration) {
                this.progressInterval = setInterval(() => this.updateProgress(), 1000);
            }
            else if(!playing && this.progressInterval) {
                this.clearProgress();
            }
        });

        this.device.on('PlaybackStopped', () => {
            this.updateProp('playing', false);
            this.updateProp('progress', 0);
            this.clearProgress();
        });

        this.device.on('AVTransport', (newValue) => {
            const mode = newValue.CurrentPlayMode;
            this.updatePlayMode(mode);
            this.updateProp('crossfade', newValue.CurrentCrossfadeMode != '0');
            if(newValue.CurrentTrackMetaDataParsed) {
                this.updateProp('track', newValue.CurrentTrackMetaDataParsed.title);
                this.updateProp('artist', newValue.CurrentTrackMetaDataParsed.artist);
                this.updateProp('album', newValue.CurrentTrackMetaDataParsed.album);
                if(!isNaN(newValue.CurrentTrackMetaDataParsed.duration)) {
                    this.currentDuration = newValue.CurrentTrackMetaDataParsed.duration;
                    if(newValue.CurrentTrackMetaDataParsed.position) {
                        this.currentPosition = newValue.CurrentTrackMetaDataParsed.position;
                    }
                    this.updateProp('progress', (this.currentPosition / this.currentDuration) * 100);

                    this.device.currentTrack().then((currentTrack) => {
                        this.currentDuration = currentTrack.duration;
                        this.currentPosition = currentTrack.position;
                        if(this.currentDuration != 0) {
                            this.updateProp('progress', (currentTrack.position / currentTrack.duration) * 100);
                            const isPlaying = this.findProperty('playing').value;
                            if(isPlaying && !this.progressInterval) {
                                this.progressInterval = setInterval(() => this.updateProgress(), 1000);
                            }
                            else if(!isPlaying) {
                                this.clearProgress();
                            }
                        }
                        else {
                            this.updateProp('progress', 0);
                            this.clearProgress();
                        }
                    });
                }
                else {
                    this.currentDuration = 0;
                    this.updateProp('progress', 0);
                    this.clearProgress();
                }
            }
            else {
                this.updateProp('track', '');
                this.updateProp('artist', '');
                this.updateProp('album', '');
                this.currentDuration = 0;
                this.updateProp('progress', 0);
                this.clearProgress();
            }
        });

        //TODO update group action
        //TODO reconnect when event listening is lost?

        if(shouldGetVolume) {
            this.device.on('Volume', (volume) => {
                this.updateProp('volume', volume);
            });
        }
        //TODO else add listener for fixed volume to be disabled
    }

    get renderingControl() {
        if(!this._renderingControl) {
            this._renderingControl = this.device.renderingControlService();
        }
        return this._renderingControl;
    }

    get avTransport() {
        if(!this._avTransport) {
            this._avTransport = this.device.avTransportService();
        }
        return this._avTransport;
    }

    async getSupportsFixedVolume() {
        const response = await this.renderingControl._request('GetSupportsOutputFixed', {InstanceID: 0});
        return response.CurrentSupportsFixed != '0';
    }

    async getFixedVolume() {
        const response = await this.renderingControl._request('GetOutputFixed', {InstanceID: 0});
        return response.CurrentFixed != '0';
    }

    async getCrossfadeMode() {
        const response = await this.avTransport.GetCrossfadeMode();
        return response.CurrrentCrossfadeMode != '0';
    }

    updatePlayMode(mode) {
        this.updateProp('shuffle', mode && mode.startsWith('SHUFFLE'));
        let repeat = 'None';
        if(mode === 'REPEAT_ALL' || mode === 'SHUFFLE') {
            repeat = 'All';
        }
        else if(mode === 'REPEAT_ONE' || mode === 'SHUFFLE_REPEAT_ONE') {
            repeat = 'One';
        }
        this.updateProp('repeat', repeat);
    }

    updateProgress() {
        this.currentPosition += 1;
        this.updateProp('progress', (this.currentPosition / this.currentDuration) * 100);
    }

    clearProgress() {
        if(this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = undefined;
        }
    }

    updateProp(propertyName, value) {
        const property = this.findProperty(propertyName);
        if(property.value !== value) {
            property.setCachedValue(value);
            super.notifyPropertyChanged(property);
        }
    }

    async notifyPropertyChanged(property) {
        const newValue = property.value;
        switch(property.name) {
            case 'playing':
                if(newValue) {
                    await this.device.play();
                }
                else {
                    console.log("pausing");
                    await this.device.pause();
                }
            break;
            case 'volume':
                //TODO reject if volume is fixed.
                await this.device.setVolume(newValue);
            break;
            case 'shuffle':
            case 'repeat':
                await this.device.setPlayMode(
                    getModeFromProps(
                        this.properties.get('shuffle').value,
                        this.properties.get('repeat').value
                    )
                );
            break;
            case 'crossfade':
                await this.avTransport.SetCrossfadeMode({ InstanceID: 0, CrossfadeMode: newValue });
            break;
            case 'progress':
                if(this.currentDuration > 0) {
                    const newPosition = Math.floor((newValue / 100) * this.currentDuration);
                    await this.device.seek(newPosition);
                    this.currentPosition = newPosition;
                }
                else {
                    throw "Can't change progress without track";
                }
            break;
        }
        super.notifyPropertyChanged(property);
    }

    async performAction(action) {
        switch(action.name) {
            case "next":
                action.start();
                await this.device.next();
                action.finish();
            break;
            case "prev":
                action.start();
                await this.device.previous();
                action.finish();
            break;
            case "group":
                action.start();
                //TODO only execute if the new group config is different from the current one.
                await this.device.leaveGroup();
                const topo = await this.device.getAllGroups();
                const topoCoordinators = topo.map((z) => z.ZoneGroupMember.find((m) => m.UUID === z.Coordinator));
                for(const input in action.input) {
                    if(action.input[input]) {
                        const deviceInfo = topoCoordinators.find((z) => z.ZoneName.toLowerCase() == input.toLowerCase());
                        const deviceIP = deviceInfo.Location.match(/^http:\/\/([^:]+)/)[1];
                        const dev = new Sonos(deviceIP);
                        await dev.joinGroup(this.name);
                    }
                }
                action.finish();
            break;
        }
    }
}
module.exports = Speaker;
